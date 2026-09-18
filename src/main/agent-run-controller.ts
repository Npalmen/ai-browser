import { ConversationStore } from '../ai/conversation-store';
import type { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import type { SafeAgentLoop, SafeAgentLoopResult } from '../agent-run/safe-agent-loop';
import {
  toAgentRunRef,
  type AgentRunCancelledReason,
  type AgentRunRef,
  type AgentRunSnapshot,
} from '../agent-run/agent-run-types';
import type { ApprovalManager } from '../approval/approval-manager';
import type { AiAnswerEvent } from '../shared/ai-types';
import type { TabId } from '../shared/browser-types';
import type { ApprovalLifecycle } from './approval-lifecycle';

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

interface ActiveAgentRun {
  readonly ref: AgentRunRef;
  readonly controller: AbortController;
  readonly instruction: string;
  /** Product request correlation only. Not browser authority. */
  readonly askId: string;
}

export interface AgentRunControllerDependencies {
  coordinator: AgentRunCoordinator;
  loop: Pick<SafeAgentLoop, 'run'>;
  conversationStore: ConversationStore;
  manager: Pick<ApprovalManager, 'getSnapshot'>;
  lifecycle: Pick<ApprovalLifecycle, 'invalidateTab'>;
  emit: (event: AiAnswerEvent) => void;
}

export class AgentRunController {
  private readonly coordinator: AgentRunCoordinator;
  private readonly loop: Pick<SafeAgentLoop, 'run'>;
  private readonly conversationStore: ConversationStore;
  private readonly manager: Pick<ApprovalManager, 'getSnapshot'>;
  private readonly lifecycle: Pick<ApprovalLifecycle, 'invalidateTab'>;
  private readonly emit: (event: AiAnswerEvent) => void;

  private readonly activeByTab = new Map<TabId, ActiveAgentRun>();
  private readonly completionByTab = new Map<TabId, Promise<SafeAgentLoopResult>>();
  private readonly startTicketByTab = new Map<TabId, number>();
  private disposed = false;

  constructor(deps: AgentRunControllerDependencies) {
    this.coordinator = deps.coordinator;
    this.loop = deps.loop;
    this.conversationStore = deps.conversationStore;
    this.manager = deps.manager;
    this.lifecycle = deps.lifecycle;
    this.emit = deps.emit;
  }

  async start(tabId: TabId, instruction: string, options: AgentRunStartOptions): Promise<AgentRunStartResult> {
    if (this.disposed) {
      return { status: 'ignored' };
    }
    const ticket = this.nextStartTicket(tabId);
    await this.terminateActive(tabId, 'SUPERSEDED');
    if (this.disposed || this.startTicketByTab.get(tabId) !== ticket) {
      return { status: 'ignored' };
    }
    return this.startFresh(tabId, instruction, options);
  }

  cancel(tabId: TabId, reason: AgentRunCancelledReason = 'USER_CANCELLED'): boolean {
    this.nextStartTicket(tabId);
    const active = this.activeByTab.get(tabId);
    if (active === undefined) {
      return false;
    }
    this.stopActive(active, reason);
    return true;
  }

  async cancelActive(
    tabId: TabId,
    reason: AgentRunCancelledReason = 'SUPERSEDED',
  ): Promise<void> {
    this.nextStartTicket(tabId);
    await this.terminateActive(tabId, reason);
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
    return this.activeByTab.has(tabId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const tabIds = [...this.activeByTab.keys()];
    for (const tabId of tabIds) {
      this.cancel(tabId, 'USER_CANCELLED');
    }
    this.activeByTab.clear();
    this.completionByTab.clear();
    this.startTicketByTab.clear();
    this.coordinator.clearAll();
    this.conversationStore.clearAll();
  }

  private startFresh(
    tabId: TabId,
    instruction: string,
    options: AgentRunStartOptions,
  ): AgentRunStartResult {
    const snapshot = this.coordinator.startRun(tabId, instruction);
    const ref = toAgentRunRef(snapshot);
    const abort = new AbortController();
    const active: ActiveAgentRun = {
      ref,
      controller: abort,
      instruction,
      askId: options.askId,
    };
    this.activeByTab.set(tabId, active);
    this.emitIfCurrent(active, {
      type: 'agent-run-started',
      askId: options.askId,
      runId: snapshot.runId,
      tabId,
      modelStepCount: snapshot.modelStepCount,
      actionAttemptCount: snapshot.actionAttemptCount,
      approvalCount: snapshot.approvalCount,
    });

    const completion = this.loop
      .run(ref, {
        signal: abort.signal,
        onAnswerTextDelta: (text) => {
          if (!text) {
            return;
          }
          this.emitIfCurrent(active, {
            type: 'answer-text',
            askId: options.askId,
            tabId,
            delta: text,
          });
        },
        priorConversationForRevision: (historyTabId, revision) =>
          this.conversationStore.serializeForRevision(historyTabId, revision),
        onContinuing: (current) => {
          this.emitIfCurrent(active, {
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
          this.emitIfCurrent(active, {
            type: 'agent-run-awaiting-approval',
            askId: options.askId,
            runId: current.runId,
            tabId: current.tabId,
            modelStepCount: current.modelStepCount,
            actionAttemptCount: current.actionAttemptCount,
            approvalCount: current.approvalCount,
          });
        },
      })
      .then((result) => {
        this.finishRun(active, result);
        if (this.completionByTab.get(tabId) === completion) {
          this.completionByTab.delete(tabId);
        }
        return result;
      });

    this.completionByTab.set(tabId, completion);
    return { status: 'started', run: snapshot, completion };
  }

  private finishRun(active: ActiveAgentRun, result: SafeAgentLoopResult): void {
    if (this.activeByTab.get(active.ref.tabId)?.ref.runId === active.ref.runId) {
      this.activeByTab.delete(active.ref.tabId);
    }

    if (result.status === 'ignored') {
      return;
    }

    const snapshot = result.run;
    if (result.status === 'completed' && snapshot.state === 'completed') {
      this.conversationStore.commitTurn(active.ref.tabId, result.answer.documentRevision, {
        question: active.instruction,
        answer: result.answer.text,
      });
      this.emitIfSameAsk(active, {
        type: 'agent-run-completed',
        askId: active.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
        answer: {
          text: result.answer.text,
          truncatedContext: result.answer.truncatedContext,
        },
      });
      return;
    }

    this.emitTerminal(active, snapshot);
  }

  private emitTerminal(active: ActiveAgentRun, snapshot: AgentRunSnapshot): void {
    if (snapshot.state === 'cancelled') {
      this.emitIfSameAsk(active, {
        type: 'agent-run-cancelled',
        askId: active.askId,
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
      this.emitIfSameAsk(active, {
        type: 'agent-run-blocked',
        askId: active.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
        reason: isBlockedReason(snapshot.terminalReason)
          ? snapshot.terminalReason
          : 'POLICY_BLOCKED',
      });
      return;
    }
    if (snapshot.state === 'failed') {
      this.emitIfSameAsk(active, {
        type: 'agent-run-failed',
        askId: active.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
        reason: snapshot.terminalReason === 'ACTION_FAILED' ? 'ACTION_FAILED' : 'MODEL_FAILED',
      });
      return;
    }
    if (snapshot.state === 'execution-state-unknown') {
      this.emitIfSameAsk(active, {
        type: 'agent-run-execution-state-unknown',
        askId: active.askId,
        runId: snapshot.runId,
        tabId: snapshot.tabId,
      });
    }
  }

  private async terminateActive(tabId: TabId, reason: AgentRunCancelledReason): Promise<void> {
    const active = this.activeByTab.get(tabId);
    if (active === undefined) {
      return;
    }
    this.stopActive(active, reason);
    await this.completionByTab.get(tabId);
  }

  private stopActive(active: ActiveAgentRun, reason: AgentRunCancelledReason): void {
    if (this.isPostDispatch(active)) {
      this.coordinator.requestCancellationAfterDispatch(active.ref, reason);
      return;
    }
    this.coordinator.cancelRun(active.ref, reason);
    active.controller.abort();
    this.lifecycle.invalidateTab(active.ref.tabId);
  }

  private isPostDispatch(active: ActiveAgentRun): boolean {
    const approvalId = this.coordinator.getPendingApprovalId(active.ref);
    if (approvalId === undefined) {
      return false;
    }
    const snapshot = this.manager.getSnapshot(approvalId);
    return (
      snapshot?.action.state === 'executing' && snapshot.facts.adapterPrimitiveInvoked === true
    );
  }

  private nextStartTicket(tabId: TabId): number {
    const next = (this.startTicketByTab.get(tabId) ?? 0) + 1;
    this.startTicketByTab.set(tabId, next);
    return next;
  }

  private emitIfCurrent(active: ActiveAgentRun, event: AiAnswerEvent): void {
    if (this.disposed) {
      return;
    }
    const current = this.activeByTab.get(active.ref.tabId);
    if (current === undefined || current.ref.runId !== active.ref.runId || current.askId !== active.askId) {
      return;
    }
    this.emitSafely(event);
  }

  private emitIfSameAsk(active: ActiveAgentRun, event: AiAnswerEvent): void {
    if (this.disposed) {
      return;
    }
    const current = this.activeByTab.get(active.ref.tabId);
    if (current !== undefined && current.askId !== active.askId) {
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
