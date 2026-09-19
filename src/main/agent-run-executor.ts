import type { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import type { SafeAgentLoop, SafeAgentLoopOptions, SafeAgentLoopResult } from '../agent-run/safe-agent-loop';
import {
  toAgentRunRef,
  type AgentRunCancelledReason,
  type AgentRunRef,
  type AgentRunSnapshot,
} from '../agent-run/agent-run-types';
import type { ApprovalManager } from '../approval/approval-manager';
import type { TabId } from '../shared/browser-types';
import type { ApprovalLifecycle } from './approval-lifecycle';

export interface AgentRunExecutorDependencies {
  coordinator: AgentRunCoordinator;
  loop: Pick<SafeAgentLoop, 'run'>;
  manager: Pick<ApprovalManager, 'getSnapshot'>;
  lifecycle: Pick<ApprovalLifecycle, 'invalidateTab'>;
}

export interface AgentRunExecutionOptions extends SafeAgentLoopOptions {
  /**
   * Trusted in-process race protection only.
   * Checked after same-tab drain and immediately before startRun.
   * Not model, renderer, or IPC input.
   */
  readonly shouldStart?: () => boolean;
  /** Observational: invoked after AgentRun creation and before SafeAgentLoop.run. */
  readonly onStarted?: (run: AgentRunSnapshot, ref: AgentRunRef) => void;
}

export type AgentRunExecutionStartResult =
  | {
      readonly status: 'started';
      readonly run: AgentRunSnapshot;
      readonly ref: AgentRunRef;
      readonly completion: Promise<SafeAgentLoopResult>;
    }
  | {
      readonly status: 'ignored';
    };

export interface AgentRunExecutorPort {
  start(
    tabId: TabId,
    instruction: string,
    options?: AgentRunExecutionOptions,
  ): Promise<AgentRunExecutionStartResult>;
  cancel(ref: AgentRunRef, reason?: AgentRunCancelledReason): boolean;
  cancelAndWait(ref: AgentRunRef, reason?: AgentRunCancelledReason): Promise<void>;
  invalidatePendingStarts(tabId: TabId): void;
  getActiveRef(tabId: TabId): AgentRunRef | undefined;
  isActive(tabId: TabId): boolean;
  dispose(): void;
}

interface ActiveExecution {
  readonly ref: AgentRunRef;
  readonly controller: AbortController;
}

/**
 * Executes one V5 AgentRun without product conversation or UI events.
 *
 * Dispose is synchronous and retains current V5 shutdown semantics:
 * pre-dispatch runs abort immediately; post-dispatch runs receive
 * `requestCancellationAfterDispatch` without awaiting V4 completion.
 * Phase 3 does not introduce async app-shutdown draining.
 */
export class AgentRunExecutor implements AgentRunExecutorPort {
  private readonly coordinator: AgentRunCoordinator;
  private readonly loop: Pick<SafeAgentLoop, 'run'>;
  private readonly manager: Pick<ApprovalManager, 'getSnapshot'>;
  private readonly lifecycle: Pick<ApprovalLifecycle, 'invalidateTab'>;

  private readonly activeByTab = new Map<TabId, ActiveExecution>();
  private readonly completionByRunId = new Map<string, Promise<SafeAgentLoopResult>>();
  private readonly startTicketByTab = new Map<TabId, number>();
  private disposed = false;

  constructor(deps: AgentRunExecutorDependencies) {
    this.coordinator = deps.coordinator;
    this.loop = deps.loop;
    this.manager = deps.manager;
    this.lifecycle = deps.lifecycle;
  }

  async start(
    tabId: TabId,
    instruction: string,
    options: AgentRunExecutionOptions = {},
  ): Promise<AgentRunExecutionStartResult> {
    if (this.disposed) {
      return { status: 'ignored' };
    }
    const ticket = this.nextStartTicket(tabId);
    await this.terminateCurrent(tabId, 'SUPERSEDED');
    if (this.disposed || this.startTicketByTab.get(tabId) !== ticket) {
      return { status: 'ignored' };
    }
    if (options.shouldStart !== undefined && !options.shouldStart()) {
      return { status: 'ignored' };
    }
    return this.startFresh(tabId, instruction, options);
  }

  cancel(ref: AgentRunRef, reason: AgentRunCancelledReason = 'USER_CANCELLED'): boolean {
    const active = this.activeByTab.get(ref.tabId);
    if (active === undefined || !sameRef(active.ref, ref)) {
      return false;
    }
    this.stopExact(active, reason);
    return true;
  }

  async cancelAndWait(
    ref: AgentRunRef,
    reason: AgentRunCancelledReason = 'USER_CANCELLED',
  ): Promise<void> {
    this.cancel(ref, reason);
    await this.completionByRunId.get(ref.runId);
  }

  invalidatePendingStarts(tabId: TabId): void {
    this.nextStartTicket(tabId);
  }

  getActiveRef(tabId: TabId): AgentRunRef | undefined {
    return this.activeByTab.get(tabId)?.ref;
  }

  isActive(tabId: TabId): boolean {
    return this.activeByTab.has(tabId);
  }

  /**
   * Prevents new starts and cancels live runs using current V5 semantics.
   * Does not asynchronously drain post-dispatch V4 execution.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const active = [...this.activeByTab.values()];
    for (const execution of active) {
      this.stopExact(execution, 'USER_CANCELLED');
    }
    this.activeByTab.clear();
    this.completionByRunId.clear();
    this.startTicketByTab.clear();
    this.coordinator.clearAll();
  }

  private startFresh(
    tabId: TabId,
    instruction: string,
    options: AgentRunExecutionOptions,
  ): AgentRunExecutionStartResult {
    const snapshot = this.coordinator.startRun(tabId, instruction);
    const ref = toAgentRunRef(snapshot);
    const abort = new AbortController();
    const active: ActiveExecution = { ref, controller: abort };
    this.activeByTab.set(tabId, active);

    const { shouldStart: _shouldStart, onStarted, ...loopOptions } = options;
    onStarted?.(snapshot, ref);
    const completion = this.loop
      .run(ref, {
        ...loopOptions,
        signal: abort.signal,
      })
      .then((result) => {
        this.finishExecution(active);
        if (this.completionByRunId.get(ref.runId) === completion) {
          this.completionByRunId.delete(ref.runId);
        }
        return result;
      });

    this.completionByRunId.set(ref.runId, completion);
    return { status: 'started', run: snapshot, ref, completion };
  }

  private finishExecution(active: ActiveExecution): void {
    const current = this.activeByTab.get(active.ref.tabId);
    if (current !== undefined && sameRef(current.ref, active.ref)) {
      this.activeByTab.delete(active.ref.tabId);
    }
  }

  private async terminateCurrent(tabId: TabId, reason: AgentRunCancelledReason): Promise<void> {
    const active = this.activeByTab.get(tabId);
    if (active === undefined) {
      return;
    }
    this.stopExact(active, reason);
    await this.completionByRunId.get(active.ref.runId);
  }

  private stopExact(active: ActiveExecution, reason: AgentRunCancelledReason): void {
    if (this.isPostDispatch(active)) {
      this.coordinator.requestCancellationAfterDispatch(active.ref, reason);
      return;
    }
    this.coordinator.cancelRun(active.ref, reason);
    active.controller.abort();
    this.lifecycle.invalidateTab(active.ref.tabId);
  }

  private isPostDispatch(active: ActiveExecution): boolean {
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
}

function sameRef(left: AgentRunRef, right: AgentRunRef): boolean {
  return left.runId === right.runId && left.tabId === right.tabId && left.generation === right.generation;
}
