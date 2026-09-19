import { ConversationStore } from '../ai/conversation-store';
import type { SafeAgentLoopResult } from '../agent-run/safe-agent-loop';
import type { AgentRunCancelledReason, AgentRunRef, AgentRunSnapshot } from '../agent-run/agent-run-types';
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
}

export interface AgentRunControllerDependencies {
  executor: AgentRunExecutorPort;
  conversationStore: ConversationStore;
  emit: (event: AiAnswerEvent) => void;
}

export class AgentRunController {
  private readonly executor: AgentRunExecutorPort;
  private readonly conversationStore: ConversationStore;
  private readonly emit: (event: AiAnswerEvent) => void;

  private readonly productByTab = new Map<TabId, ProductAgentRun>();
  private disposed = false;

  constructor(deps: AgentRunControllerDependencies) {
    this.executor = deps.executor;
    this.conversationStore = deps.conversationStore;
    this.emit = deps.emit;
  }

  async start(tabId: TabId, instruction: string, options: AgentRunStartOptions): Promise<AgentRunStartResult> {
    if (this.disposed) {
      return { status: 'ignored' };
    }
    let product: ProductAgentRun | undefined;
    const started = await this.executor.start(tabId, instruction, {
      shouldStart: () => !this.disposed,
      onStarted: (run, ref) => {
        product = {
          ref,
          instruction,
          askId: options.askId,
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
        if (!text) {
          return;
        }
        this.emitIfCurrentAsk(tabId, options.askId, {
          type: 'answer-text',
          askId: options.askId,
          tabId,
          delta: text,
        });
      },
      priorConversationForRevision: (historyTabId, revision) =>
        this.conversationStore.serializeForRevision(historyTabId, revision),
      onContinuing: (current) => {
        this.emitIfCurrentRun(tabId, options.askId, current.runId, {
          type: 'agent-run-progress',
          askId: options.askId,
          runId: current.runId,
          tabId: current.tabId,
          modelStepCount: current.modelStepCount,
          actionAttemptCount: current.actionAttemptCount,
          approvalCount: current.approvalCount,
        });
      },
      onAwaitingApproval: (current) => {
        this.emitIfCurrentRun(tabId, options.askId, current.runId, {
          type: 'agent-run-awaiting-approval',
          askId: options.askId,
          runId: current.runId,
          tabId: current.tabId,
          modelStepCount: current.modelStepCount,
          actionAttemptCount: current.actionAttemptCount,
          approvalCount: current.approvalCount,
        });
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
    return this.productByTab.has(tabId);
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
    return this.productByTab.get(tabId)?.ref ?? this.executor.getActiveRef(tabId);
  }

  private finishRun(product: ProductAgentRun, result: SafeAgentLoopResult): void {
    const current = this.productByTab.get(product.ref.tabId);
    if (current !== undefined && current.ref.runId === product.ref.runId && current.askId === product.askId) {
      this.productByTab.delete(product.ref.tabId);
    }

    if (result.status === 'ignored') {
      return;
    }

    const snapshot = result.run;
    if (result.status === 'completed' && snapshot.state === 'completed') {
      this.conversationStore.commitTurn(product.ref.tabId, result.answer.documentRevision, {
        question: product.instruction,
        answer: result.answer.text,
      });
      this.emitIfSameAsk(product, {
        type: 'agent-run-completed',
        askId: product.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
        answer: {
          text: result.answer.text,
          truncatedContext: result.answer.truncatedContext,
        },
      });
      return;
    }

    this.emitTerminal(product, snapshot);
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
      this.emitIfSameAsk(product, {
        type: 'agent-run-failed',
        askId: product.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
        reason: snapshot.terminalReason === 'ACTION_FAILED' ? 'ACTION_FAILED' : 'MODEL_FAILED',
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
    const current = this.productByTab.get(product.ref.tabId);
    if (current !== undefined && current.askId !== product.askId) {
      return;
    }
    this.emitSafely(event);
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
