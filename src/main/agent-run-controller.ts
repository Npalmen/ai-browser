import { ConversationStore } from '../ai/conversation-store';
import { aiSafeError } from './ai-safe-error';
import type { SafeAgentLoopResult } from '../agent-run/safe-agent-loop';
import {
  conversationTabIdForSnapshot,
  type AgentRunCancelledReason,
  type AgentRunRef,
  type AgentRunSnapshot,
} from '../agent-run/agent-run-types';
import type { AiAnswerEvent } from '../shared/ai-types';
import type { TabId } from '../shared/browser-types';
import type { AgentRunExecutorPort } from './agent-run-executor';

export interface AgentRunStartOptions {
  readonly askId: string;
  readonly onAnswerTextDelta?: (text: string) => void;
}

export type AgentRunStartResult =
  | {
      readonly status: 'started';
      readonly run: AgentRunSnapshot;
      readonly completion: Promise<SafeAgentLoopResult>;
    }
  | {
      readonly status: 'ignored';
    };

interface ProductAgentRun {
  readonly ref: AgentRunRef;
  readonly instruction: string;
  /** Product request correlation only. Not browser authority. */
  readonly askId: string;
  /** Trusted product/UI tab for streamed answer text and active progress. */
  currentUiTabId: TabId;
}

export interface AgentRunControllerDependencies {
  executor: AgentRunExecutorPort;
  conversationStore: ConversationStore;
  emit: (event: AiAnswerEvent) => void;
  /**
   * Trusted-main ownership gate. When false, this product wrapper must not
   * start a manual Act on the tab. Re-checked inside executor shouldStart.
   */
  canStartManualAct?: (tabId: TabId) => boolean;
}

export class AgentRunController {
  private readonly executor: AgentRunExecutorPort;
  private readonly conversationStore: ConversationStore;
  private readonly emit: (event: AiAnswerEvent) => void;
  private readonly canStartManualAct: ((tabId: TabId) => boolean) | undefined;

  private readonly productByTab = new Map<TabId, ProductAgentRun>();
  private disposed = false;

  constructor(deps: AgentRunControllerDependencies) {
    this.executor = deps.executor;
    this.conversationStore = deps.conversationStore;
    this.emit = deps.emit;
    this.canStartManualAct = deps.canStartManualAct;
  }

  async start(tabId: TabId, instruction: string, options: AgentRunStartOptions): Promise<AgentRunStartResult> {
    if (this.disposed) {
      return { status: 'ignored' };
    }
    if (!this.mayStartManualAct(tabId)) {
      return { status: 'ignored' };
    }
    let product: ProductAgentRun | undefined;
    const started = await this.executor.start(tabId, instruction, {
      shouldStart: () => !this.disposed && this.mayStartManualAct(tabId),
      onStarted: (run, ref) => {
        product = {
          ref,
          instruction,
          askId: options.askId,
          currentUiTabId: tabId,
        };
        this.productByTab.set(tabId, product);
        this.emitIfCurrentRun(tabId, options.askId, run.runId, {
          type: 'agent-run-started',
          askId: options.askId,
          runId: run.runId,
          tabId,
          modelStepCount: run.modelStepCount,
          actionAttemptCount: run.actionAttemptCount,
          approvalCount: run.approvalCount,
        });
      },
      onAnswerTextDelta: (text) => {
        if (!text || product === undefined) {
          return;
        }
        const uiTabId = product.currentUiTabId;
        this.emitIfCurrentAsk(uiTabId, options.askId, {
          type: 'answer-text',
          askId: options.askId,
          tabId: uiTabId,
          delta: text,
        });
      },
      priorConversationForRevision: (historyTabId, revision) =>
        this.conversationStore.serializeForActRevision(historyTabId, revision),
      onContinuing: (current) => {
        this.syncProductUiTab(product, current);
        this.emitRunLifecycle(product, current, 'agent-run-progress');
      },
      onAwaitingApproval: (current) => {
        this.syncProductUiTab(product, current);
        this.emitRunLifecycle(product, current, 'agent-run-awaiting-approval');
      },
    });
    if (started.status !== 'started' || product === undefined) {
      return { status: 'ignored' };
    }

    const tracked = product;
    const completion = started.completion.then((result) => {
      this.finishRun(tracked, result);
      return result;
    });
    return { status: 'started', run: started.run, completion };
  }

  cancel(tabId: TabId, reason: AgentRunCancelledReason = 'USER_CANCELLED'): boolean {
    this.executor.invalidatePendingStarts(tabId);
    const ref = this.exactRefForTab(tabId);
    if (ref === undefined) {
      return false;
    }
    return this.executor.cancel(ref, reason);
  }

  async cancelActive(
    tabId: TabId,
    reason: AgentRunCancelledReason = 'SUPERSEDED',
  ): Promise<void> {
    this.executor.invalidatePendingStarts(tabId);
    const ref = this.exactRefForTab(tabId);
    if (ref === undefined) {
      return;
    }
    await this.executor.cancelAndWait(ref, reason);
  }

  clearConversation(tabId: TabId): void {
    this.cancel(tabId, 'USER_CANCELLED');
    this.conversationStore.clear(tabId);
  }

  handleTabClosed(tabId: TabId): void {
    this.cancel(tabId, 'TAB_CLOSED');
    this.conversationStore.clear(tabId);
  }

  handleRendererCrash(tabId: TabId): void {
    this.cancel(tabId, 'RENDERER_CRASH');
    this.conversationStore.clear(tabId);
  }

  cancelForTrustedChromeNavigation(tabId: TabId): void {
    this.cancel(tabId, 'TRUSTED_CHROME_NAVIGATION');
  }

  isActive(tabId: TabId): boolean {
    return this.productForTab(tabId) !== undefined;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const tracked = [...this.productByTab.values()];
    for (const product of tracked) {
      this.executor.invalidatePendingStarts(product.ref.tabId);
      this.executor.cancel(product.ref, 'USER_CANCELLED');
    }
    this.productByTab.clear();
    this.conversationStore.clearAll();
  }

  private exactRefForTab(tabId: TabId): AgentRunRef | undefined {
    return this.productForTab(tabId)?.ref;
  }

  private productForTab(tabId: TabId): ProductAgentRun | undefined {
    const direct = this.productByTab.get(tabId);
    if (direct !== undefined) {
      return direct;
    }
    const active = this.executor.getActiveRef(tabId);
    if (active === undefined) {
      return undefined;
    }
    const origin = this.productByTab.get(active.tabId);
    if (origin === undefined || origin.ref.runId !== active.runId) {
      return undefined;
    }
    return origin;
  }

  private mayStartManualAct(tabId: TabId): boolean {
    return this.canStartManualAct?.(tabId) !== false;
  }

  private syncProductUiTab(
    product: ProductAgentRun | undefined,
    snapshot: AgentRunSnapshot,
  ): void {
    if (product === undefined) {
      return;
    }
    product.currentUiTabId = conversationTabIdForSnapshot(snapshot);
    this.aliasProductToExecutionTab(product, snapshot);
  }

  private aliasProductToExecutionTab(
    product: ProductAgentRun | undefined,
    snapshot: AgentRunSnapshot,
  ): void {
    if (product === undefined) {
      return;
    }
    const executionTabId = snapshot.executionTabId;
    if (executionTabId === undefined || executionTabId === product.ref.tabId) {
      return;
    }
    const existing = this.productByTab.get(executionTabId);
    if (existing !== undefined && existing.ref.runId !== product.ref.runId) {
      return;
    }
    this.productByTab.set(executionTabId, product);
  }

  private emitRunLifecycle(
    product: ProductAgentRun | undefined,
    snapshot: AgentRunSnapshot,
    type: 'agent-run-progress' | 'agent-run-awaiting-approval',
  ): void {
    if (product === undefined) {
      return;
    }
    const payload = {
      type,
      askId: product.askId,
      runId: snapshot.runId,
      modelStepCount: snapshot.modelStepCount,
      actionAttemptCount: snapshot.actionAttemptCount,
      approvalCount: snapshot.approvalCount,
    };
    this.emitIfCurrentRun(product.ref.tabId, product.askId, snapshot.runId, {
      ...payload,
      tabId: product.ref.tabId,
    });
    const executionTabId = snapshot.executionTabId;
    if (executionTabId !== undefined && executionTabId !== product.ref.tabId) {
      this.emitIfCurrentRun(executionTabId, product.askId, snapshot.runId, {
        ...payload,
        tabId: executionTabId,
      });
    }
  }

  private finishRun(product: ProductAgentRun, result: SafeAgentLoopResult): void {
    if (result.status === 'ignored') {
      this.detachProduct(product);
      return;
    }

    const snapshot = result.run;
    if (result.status === 'completed' && snapshot.state === 'completed') {
      const conversationTabId = conversationTabIdForSnapshot(snapshot);
      this.conversationStore.commitTurn(conversationTabId, result.answer.documentRevision, {
        question: product.instruction,
        answer: result.answer.text,
      });
      this.emitDetachedMirrors(product, snapshot, conversationTabId);
      this.emitIfCurrentRun(conversationTabId, product.askId, snapshot.runId, {
        type: 'agent-run-completed',
        askId: product.askId,
        runId: snapshot.runId,
        tabId: conversationTabId,
        answer: {
          text: result.answer.text,
          truncatedContext: result.answer.truncatedContext,
        },
      });
      this.detachProduct(product);
      return;
    }

    this.emitTerminal(product, snapshot);
    this.detachProduct(product);
  }

  private emitDetachedMirrors(
    product: ProductAgentRun,
    snapshot: AgentRunSnapshot,
    conversationTabId: TabId,
  ): void {
    for (const [tabId, current] of this.productByTab.entries()) {
      if (
        tabId !== conversationTabId &&
        current.ref.runId === product.ref.runId &&
        current.askId === product.askId
      ) {
        this.emitIfCurrentRun(tabId, product.askId, snapshot.runId, {
          type: 'agent-run-detached',
          askId: product.askId,
          runId: snapshot.runId,
          tabId,
        });
      }
    }
  }

  private detachProduct(product: ProductAgentRun): void {
    for (const [tabId, current] of [...this.productByTab.entries()]) {
      if (current.ref.runId === product.ref.runId && current.askId === product.askId) {
        this.productByTab.delete(tabId);
      }
    }
  }

  private emitTerminal(product: ProductAgentRun, snapshot: AgentRunSnapshot): void {
    if (snapshot.state === 'cancelled') {
      this.emitIfSameAsk(product, {
        type: 'agent-run-cancelled',
        askId: product.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
        reason: snapshot.terminalReason === 'SUPERSEDED' ||
          snapshot.terminalReason === 'TAB_CLOSED' ||
          snapshot.terminalReason === 'RENDERER_CRASH' ||
          snapshot.terminalReason === 'TRUSTED_CHROME_NAVIGATION'
          ? snapshot.terminalReason
          : 'USER_CANCELLED',
      });
      return;
    }
    if (snapshot.state === 'blocked') {
      this.emitIfSameAsk(product, {
        type: 'agent-run-blocked',
        askId: product.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
        reason: isBlockedReason(snapshot.terminalReason)
          ? snapshot.terminalReason
          : 'POLICY_BLOCKED',
      });
      return;
    }
    if (snapshot.state === 'failed') {
      const reason = snapshot.terminalReason === 'ACTION_FAILED' ? 'ACTION_FAILED' : 'MODEL_FAILED';
      this.emitIfSameAsk(product, {
        type: 'agent-run-failed',
        askId: product.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
        reason,
        ...(reason === 'MODEL_FAILED' && snapshot.modelErrorCode !== undefined
          ? { safeMessage: aiSafeError(snapshot.modelErrorCode).message }
          : {}),
      });
      return;
    }
    if (snapshot.state === 'execution-state-unknown') {
      this.emitIfSameAsk(product, {
        type: 'agent-run-execution-state-unknown',
        askId: product.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
      });
    }
  }

  private emitIfCurrentAsk(tabId: TabId, askId: string, event: AiAnswerEvent): void {
    if (this.disposed) {
      return;
    }
    const current = this.productByTab.get(tabId);
    if (current === undefined || current.askId !== askId) {
      return;
    }
    this.emitSafely(event);
  }

  private emitIfCurrentRun(tabId: TabId, askId: string, runId: string, event: AiAnswerEvent): void {
    if (this.disposed) {
      return;
    }
    const current = this.productByTab.get(tabId);
    if (current === undefined || current.askId !== askId || current.ref.runId !== runId) {
      return;
    }
    this.emitSafely(event);
  }

  private emitIfSameAsk(product: ProductAgentRun, event: AiAnswerEvent): void {
    if (this.disposed) {
      return;
    }
    const origin = this.productByTab.get(product.ref.tabId);
    if (origin !== undefined && origin.askId !== product.askId) {
      return;
    }
    this.emitSafely(event);
    if (!('tabId' in event)) {
      return;
    }
    for (const [tabId, current] of this.productByTab.entries()) {
      if (
        tabId !== event.tabId &&
        current.ref.runId === product.ref.runId &&
        current.askId === product.askId
      ) {
        this.emitSafely({ ...event, tabId });
      }
    }
  }

  private emitSafely(event: AiAnswerEvent): void {
    try {
      this.emit(event);
    } catch {
      // Renderer emission is observational and must not alter run authority.
    }
  }
}

function isBlockedReason(
  reason: AgentRunSnapshot['terminalReason'],
): reason is
  | 'STEP_LIMIT_REACHED'
  | 'AGENT_LOOP_NO_PROGRESS'
  | 'POLICY_BLOCKED'
  | 'UNSUPPORTED_ACTION'
  | 'ACTION_STALE'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED' {
  return (
    reason === 'STEP_LIMIT_REACHED' ||
    reason === 'AGENT_LOOP_NO_PROGRESS' ||
    reason === 'POLICY_BLOCKED' ||
    reason === 'UNSUPPORTED_ACTION' ||
    reason === 'ACTION_STALE' ||
    reason === 'APPROVAL_REJECTED' ||
    reason === 'APPROVAL_EXPIRED'
  );
}
