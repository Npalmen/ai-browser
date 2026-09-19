import type { AgentRunCancelledReason, AgentRunRef, AgentRunSnapshot } from '../agent-run/agent-run-types';
import type {
  AutonomousTaskAgentRunCompletion,
  AutonomousTaskAgentRunExecutionPort,
} from './agent-run-execution-port';
import { AutonomousTaskCoordinator } from './autonomous-task-coordinator';
import { AutonomousTaskError } from './autonomous-task-errors';
import type { ModelSubgoalResult } from './autonomous-task-planner-context';
import {
  isAutonomousTaskApplied,
  type AutonomousTaskBlockedReason,
  type AutonomousTaskRef,
  type AutonomousTaskSnapshot,
} from './autonomous-task-types';
import { fingerprintSubgoal } from './task-no-progress';
import { TaskTabStateRegistry } from './task-tab-state-registry';

export interface AutonomousTaskChildRunRequest {
  readonly ref: AutonomousTaskRef;
  readonly taskTabAlias: string;
  readonly instruction: string;
}

export type AutonomousTaskChildRunResult =
  | {
      readonly status: 'completed';
      readonly snapshot: AutonomousTaskSnapshot;
      readonly result: ModelSubgoalResult;
    }
  | {
      readonly status: 'terminal';
      readonly snapshot: AutonomousTaskSnapshot;
    }
  | {
      readonly status: 'lifecycle-cancelled';
      readonly snapshot: AutonomousTaskSnapshot;
    }
  | {
      readonly status: 'ignored';
    };

export interface AutonomousTaskActiveChild {
  readonly taskRef: AutonomousTaskRef;
  readonly agentRunRef: AgentRunRef;
  readonly taskTabAlias: string;
  readonly tabId: string;
}

interface ActiveChildCorrelation {
  readonly taskRef: AutonomousTaskRef;
  readonly agentRunRef: AgentRunRef;
  readonly taskTabAlias: string;
  readonly fingerprint: string;
  readonly tabId: string;
  lifecycleCancellationRequested: boolean;
  readonly settled: Promise<AutonomousTaskChildRunResult>;
  resolveSettled: (result: AutonomousTaskChildRunResult) => void;
}

export interface AutonomousTaskChildRunExecutorDependencies {
  coordinator: AutonomousTaskCoordinator;
  agentRuns: AutonomousTaskAgentRunExecutionPort;
  tabState: TaskTabStateRegistry;
}

export class AutonomousTaskChildRunExecutor {
  private readonly coordinator: AutonomousTaskCoordinator;
  private readonly agentRuns: AutonomousTaskAgentRunExecutionPort;
  private readonly tabState: TaskTabStateRegistry;
  private readonly activeByTask = new Map<string, ActiveChildCorrelation>();

  constructor(deps: AutonomousTaskChildRunExecutorDependencies) {
    this.coordinator = deps.coordinator;
    this.agentRuns = deps.agentRuns;
    this.tabState = deps.tabState;
  }

  async execute(request: AutonomousTaskChildRunRequest): Promise<AutonomousTaskChildRunResult> {
    const inspected = this.coordinator.inspectTask(request.ref);
    if (inspected.status !== 'current') {
      return { status: 'ignored' };
    }
    if (inspected.snapshot.state !== 'planning') {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${request.ref.taskId} must be planning to start a child run.`,
      );
    }

    const owned = this.coordinator.resolveTaskTabAlias(request.ref.taskId, request.taskTabAlias);
    if (owned === undefined) {
      const blocked = this.coordinator.markBlocked(request.ref, 'TAB_OWNERSHIP_VIOLATION');
      return this.appliedOrIgnored(blocked);
    }

    const trustedTabStateToken = this.tabState.getToken(request.ref.taskId, request.taskTabAlias);
    if (trustedTabStateToken === undefined) {
      const blocked = this.coordinator.markBlocked(request.ref, 'TAB_OWNERSHIP_VIOLATION');
      return this.appliedOrIgnored(blocked);
    }

    const fingerprint = fingerprintSubgoal({
      taskTabAlias: request.taskTabAlias,
      delegatedInstruction: request.instruction,
      trustedTabStateToken,
    });

    const noProgress = this.coordinator.assertNoImmediateRepeatedSubgoal(request.ref, fingerprint);
    if (noProgress.status === 'ignored') {
      return { status: 'ignored' };
    }
    if (isAutonomousTaskApplied(noProgress) && noProgress.snapshot.state === 'blocked') {
      this.tabState.releaseTask(request.ref.taskId);
      return { status: 'terminal', snapshot: noProgress.snapshot };
    }

    if (this.activeByTask.has(request.ref.taskId)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${request.ref.taskId} already has an active child run.`,
      );
    }

    const begun = this.coordinator.beginChildRun(request.ref);
    if (begun.status === 'ignored') {
      return { status: 'ignored' };
    }
    if (isAutonomousTaskApplied(begun) && begun.snapshot.state === 'blocked') {
      this.tabState.releaseTask(request.ref.taskId);
      return { status: 'terminal', snapshot: begun.snapshot };
    }

    const tabId = owned.tabId;
    const started = await this.agentRuns.start(tabId, request.instruction, {
      shouldStart: () => this.canStartChild(request, tabId),
    });
    if (started.status !== 'started') {
      return this.missingExpectedChild(request.ref);
    }

    let resolveSettled!: (result: AutonomousTaskChildRunResult) => void;
    const settled = new Promise<AutonomousTaskChildRunResult>((resolve) => {
      resolveSettled = resolve;
    });
    this.activeByTask.set(request.ref.taskId, {
      taskRef: request.ref,
      agentRunRef: started.ref,
      taskTabAlias: request.taskTabAlias,
      fingerprint,
      tabId,
      lifecycleCancellationRequested: false,
      settled,
      resolveSettled,
    });

    const completion = await started.completion;
    const result = this.finishChild(request, fingerprint, started.ref, completion);
    resolveSettled(result);
    return result;
  }

  getActiveChild(taskId: string): AutonomousTaskActiveChild | undefined {
    const active = this.activeByTask.get(taskId);
    if (active === undefined) {
      return undefined;
    }
    return {
      taskRef: active.taskRef,
      agentRunRef: active.agentRunRef,
      taskTabAlias: active.taskTabAlias,
      tabId: active.tabId,
    };
  }

  async cancelActiveChildForLifecycle(
    ref: AutonomousTaskRef,
    reason: AgentRunCancelledReason,
  ): Promise<AutonomousTaskChildRunResult> {
    const active = this.activeByTask.get(ref.taskId);
    if (
      active === undefined ||
      active.taskRef.generation !== ref.generation ||
      active.agentRunRef.runId === undefined
    ) {
      return { status: 'ignored' };
    }
    active.lifecycleCancellationRequested = true;
    await this.agentRuns.cancelAndWait(active.agentRunRef, reason);
    return active.settled;
  }

  private canStartChild(request: AutonomousTaskChildRunRequest, expectedTabId: string): boolean {
    const inspected = this.coordinator.inspectTask(request.ref);
    if (inspected.status !== 'current' || inspected.snapshot.state !== 'running-subgoal') {
      return false;
    }
    const owned = this.coordinator.resolveTaskTabAlias(request.ref.taskId, request.taskTabAlias);
    return owned?.tabId === expectedTabId;
  }

  private finishChild(
    request: AutonomousTaskChildRunRequest,
    fingerprint: string,
    agentRunRef: AgentRunRef,
    completion: AutonomousTaskAgentRunCompletion,
  ): AutonomousTaskChildRunResult {
    if (!this.isExactCurrentChild(request.ref, agentRunRef)) {
      this.clearIfMatch(request.ref.taskId, agentRunRef);
      return { status: 'ignored' };
    }

    if (completion.status === 'ignored') {
      return this.failCurrentChild(request.ref, agentRunRef);
    }

    const snapshot = completion.run;
    if (completion.status === 'completed' && snapshot.state === 'completed') {
      const recorded = this.coordinator.recordCompletedSubgoalFingerprint(request.ref, fingerprint);
      if (recorded.status === 'ignored') {
        this.clearIfMatch(request.ref.taskId, agentRunRef);
        return { status: 'ignored' };
      }
      const completed = this.coordinator.markChildCompleted(request.ref);
      this.clearIfMatch(request.ref.taskId, agentRunRef);
      if (completed.status === 'ignored') {
        return { status: 'ignored' };
      }
      if (snapshot.actionAttemptCount > 0) {
        this.tabState.incrementForAlias(request.ref.taskId, request.taskTabAlias);
      }
      return {
        status: 'completed',
        snapshot: completed.snapshot,
        result: {
          kind: 'model-subgoal-result',
          taskTabAlias: request.taskTabAlias,
          text: completion.answer.text,
        },
      };
    }

    return this.mapTerminalChild(request.ref, agentRunRef, snapshot);
  }

  private mapTerminalChild(
    ref: AutonomousTaskRef,
    agentRunRef: AgentRunRef,
    snapshot: AgentRunSnapshot,
  ): AutonomousTaskChildRunResult {
    if (!this.isExactCurrentChild(ref, agentRunRef)) {
      this.clearIfMatch(ref.taskId, agentRunRef);
      return { status: 'ignored' };
    }

    if (snapshot.state === 'blocked') {
      const blocked = this.coordinator.markBlocked(ref, mapBlockedReason(snapshot.terminalReason));
      this.clearIfMatch(ref.taskId, agentRunRef);
      return this.releaseOnTerminal(ref, this.appliedOrIgnored(blocked));
    }
    if (snapshot.state === 'execution-state-unknown') {
      const unknown = this.coordinator.markExecutionStateUnknown(ref);
      this.clearIfMatch(ref.taskId, agentRunRef);
      return this.releaseOnTerminal(ref, this.appliedOrIgnored(unknown));
    }
    if (snapshot.state === 'cancelled') {
      const active = this.activeByTask.get(ref.taskId);
      if (active?.lifecycleCancellationRequested === true) {
        this.clearIfMatch(ref.taskId, agentRunRef);
        const current = this.coordinator.inspectTask(ref);
        if (current.status === 'current' && current.snapshot.state === 'running-subgoal') {
          return { status: 'lifecycle-cancelled', snapshot: current.snapshot };
        }
        return { status: 'ignored' };
      }
      return this.failCurrentChild(ref, agentRunRef);
    }
    if (snapshot.state === 'failed') {
      return this.failCurrentChild(ref, agentRunRef);
    }
    return this.failCurrentChild(ref, agentRunRef);
  }

  private missingExpectedChild(ref: AutonomousTaskRef): AutonomousTaskChildRunResult {
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status !== 'current' || inspected.snapshot.state !== 'running-subgoal') {
      return { status: 'ignored' };
    }
    const failed = this.coordinator.markFailed(ref, 'CHILD_RUN_FAILED');
    return this.releaseOnTerminal(ref, this.appliedOrIgnored(failed));
  }

  private failCurrentChild(
    ref: AutonomousTaskRef,
    agentRunRef: AgentRunRef,
  ): AutonomousTaskChildRunResult {
    if (!this.isExactCurrentChild(ref, agentRunRef)) {
      this.clearIfMatch(ref.taskId, agentRunRef);
      return { status: 'ignored' };
    }
    const failed = this.coordinator.markFailed(ref, 'CHILD_RUN_FAILED');
    this.clearIfMatch(ref.taskId, agentRunRef);
    return this.releaseOnTerminal(ref, this.appliedOrIgnored(failed));
  }

  private isExactCurrentChild(
    ref: AutonomousTaskRef,
    agentRunRef: AgentRunRef,
  ): boolean {
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status !== 'current' || inspected.snapshot.state !== 'running-subgoal') {
      return false;
    }
    const active = this.activeByTask.get(ref.taskId);
    return (
      active !== undefined &&
      active.taskRef.generation === ref.generation &&
      active.agentRunRef.runId === agentRunRef.runId &&
      active.agentRunRef.generation === agentRunRef.generation
    );
  }

  private clearIfMatch(
    taskId: string,
    agentRunRef: AgentRunRef,
  ): void {
    const active = this.activeByTask.get(taskId);
    if (active !== undefined && active.agentRunRef.runId === agentRunRef.runId) {
      this.activeByTask.delete(taskId);
    }
  }

  private appliedOrIgnored(
    result: { status: 'applied'; snapshot: AutonomousTaskSnapshot } | { status: 'ignored' },
  ): AutonomousTaskChildRunResult {
    if (result.status === 'ignored') {
      return { status: 'ignored' };
    }
    return { status: 'terminal', snapshot: result.snapshot };
  }

  private releaseOnTerminal(
    ref: AutonomousTaskRef,
    result: AutonomousTaskChildRunResult,
  ): AutonomousTaskChildRunResult {
    if (result.status === 'terminal') {
      this.tabState.releaseTask(ref.taskId);
    }
    return result;
  }
}

function mapBlockedReason(reason: AgentRunSnapshot['terminalReason']): AutonomousTaskBlockedReason {
  switch (reason) {
    case 'POLICY_BLOCKED':
    case 'UNSUPPORTED_ACTION':
      return 'POLICY_BLOCKED';
    case 'ACTION_STALE':
      return 'ACTION_STALE';
    case 'APPROVAL_REJECTED':
      return 'APPROVAL_REJECTED';
    case 'APPROVAL_EXPIRED':
      return 'APPROVAL_EXPIRED';
    case 'AGENT_LOOP_NO_PROGRESS':
      return 'TASK_NO_PROGRESS';
    case 'STEP_LIMIT_REACHED':
      return 'TASK_LIMIT_REACHED';
    default:
      return 'POLICY_BLOCKED';
  }
}
