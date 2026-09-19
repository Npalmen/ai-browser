import type { AgentRunRef } from '../agent-run/agent-run-types';
import type { TrustedAgentApprovalOutcome } from '../agent-run/approval-outcome';
import {
  AutonomousTaskChildRunExecutor,
  type AutonomousTaskChildLifecycleIntent,
} from '../autonomous-task/autonomous-task-child-run-executor';
import { AutonomousTaskCoordinator } from '../autonomous-task/autonomous-task-coordinator';
import {
  isAutonomousTaskApplied,
  isTerminalAutonomousTaskState,
  type AutonomousTaskMutationResult,
  type AutonomousTaskRef,
} from '../autonomous-task/autonomous-task-types';
import { TaskTabStateRegistry } from '../autonomous-task/task-tab-state-registry';
import type {
  AgentRunTaskApprovalPort,
  AgentRunTaskApprovalPrecheckResult,
  AgentRunTaskApprovalPresentedResult,
} from './agent-run-approval-bridge';

interface TaskApprovalCorrelation {
  readonly approvalId: string;
  readonly taskRef: AutonomousTaskRef;
  readonly agentRunRef: AgentRunRef;
  readonly taskTabAlias: string;
}

export interface AutonomousTaskApprovalIntegrationDependencies {
  coordinator: AutonomousTaskCoordinator;
  childRuns: AutonomousTaskChildRunExecutor;
  tabState: TaskTabStateRegistry;
}

/**
 * Trusted-main correlation between V4 approvalIds and exact V6 child runs.
 * Not V4 authority. Manual AgentRuns remain unrelated.
 */
export class AutonomousTaskApprovalIntegration implements AgentRunTaskApprovalPort {
  private readonly coordinator: AutonomousTaskCoordinator;
  private readonly childRuns: AutonomousTaskChildRunExecutor;
  private readonly tabState: TaskTabStateRegistry;
  private readonly byApprovalId = new Map<string, TaskApprovalCorrelation>();

  constructor(deps: AutonomousTaskApprovalIntegrationDependencies) {
    this.coordinator = deps.coordinator;
    this.childRuns = deps.childRuns;
    this.tabState = deps.tabState;
  }

  beforePrepare(ref: AgentRunRef): AgentRunTaskApprovalPrecheckResult {
    const child = this.childRuns.findActiveChildByAgentRunRef(ref);
    if (child === undefined) {
      return 'unrelated';
    }
    const inspected = this.coordinator.inspectTask(child.taskRef);
    if (inspected.status !== 'current' || inspected.snapshot.state !== 'running-subgoal') {
      return 'ignored';
    }
    let budget: AutonomousTaskMutationResult;
    try {
      budget = this.coordinator.assertApprovalBudgetAvailable(child.taskRef);
    } catch {
      return 'ignored';
    }
    if (budget.status === 'ignored') {
      return 'ignored';
    }
    if (isTerminalAutonomousTaskState(budget.snapshot.state)) {
      this.releaseTaskLocalState(child.taskRef.taskId);
      return 'blocked';
    }
    return 'allow';
  }

  onPresented(ref: AgentRunRef, approvalId: string): AgentRunTaskApprovalPresentedResult {
    const child = this.childRuns.findActiveChildByAgentRunRef(ref);
    if (child === undefined) {
      return 'unrelated';
    }
    if (typeof approvalId !== 'string' || approvalId.trim().length === 0) {
      return 'ignored';
    }
    let presented: AutonomousTaskMutationResult;
    try {
      presented = this.coordinator.recordApprovalPresented(child.taskRef);
    } catch {
      return 'ignored';
    }
    if (presented.status === 'ignored') {
      return 'ignored';
    }
    if (isTerminalAutonomousTaskState(presented.snapshot.state)) {
      this.releaseTaskLocalState(child.taskRef.taskId);
      return 'blocked';
    }
    this.byApprovalId.set(approvalId, {
      approvalId,
      taskRef: child.taskRef,
      agentRunRef: child.agentRunRef,
      taskTabAlias: child.taskTabAlias,
    });
    return 'applied';
  }

  notifyApprovalOutcome(approvalId: string, outcome: TrustedAgentApprovalOutcome): void {
    const correlation = this.byApprovalId.get(approvalId);
    if (correlation === undefined) {
      return;
    }
    this.byApprovalId.delete(approvalId);
    const intent = this.lookupIntent(correlation.agentRunRef);
    this.applyTrustedOutcome(correlation.taskRef, outcome, intent);
  }

  considerUserReply(_ref: AutonomousTaskRef, _text: string): 'ignored' {
    return 'ignored';
  }

  dispose(): void {
    this.byApprovalId.clear();
  }

  private lookupIntent(ref: AgentRunRef): AutonomousTaskChildLifecycleIntent | undefined {
    return this.childRuns.findActiveChildByAgentRunRef(ref)?.lifecycleIntent;
  }

  private applyTrustedOutcome(
    ref: AutonomousTaskRef,
    outcome: TrustedAgentApprovalOutcome,
    intent: AutonomousTaskChildLifecycleIntent | undefined,
  ): void {
    if (outcome === 'execution-state-unknown') {
      this.mutateAndRelease(ref, () => this.coordinator.markExecutionStateUnknown(ref));
      return;
    }
    if (outcome === 'executed') {
      if (intent !== undefined) {
        return;
      }
      this.mutate(ref, () => this.coordinator.markApprovalExecuted(ref));
      return;
    }
    if (outcome === 'stale' && intent !== undefined) {
      return;
    }
    if (outcome === 'rejected') {
      this.mutateAndRelease(ref, () => this.coordinator.markBlocked(ref, 'APPROVAL_REJECTED'));
      return;
    }
    if (outcome === 'expired') {
      this.mutateAndRelease(ref, () => this.coordinator.markBlocked(ref, 'APPROVAL_EXPIRED'));
      return;
    }
    if (outcome === 'stale') {
      this.mutateAndRelease(ref, () => this.coordinator.markBlocked(ref, 'ACTION_STALE'));
      return;
    }
    this.mutateAndRelease(ref, () => this.coordinator.markFailed(ref, 'CHILD_RUN_FAILED'));
  }

  private mutate(
    ref: AutonomousTaskRef,
    act: () => AutonomousTaskMutationResult,
  ): AutonomousTaskMutationResult {
    const inspected = this.coordinator.inspectTask(ref);
    if (
      inspected.status === 'missing' ||
      inspected.status === 'superseded' ||
      inspected.status === 'terminal' ||
      inspected.status === 'paused'
    ) {
      return { status: 'ignored' };
    }
    try {
      return act();
    } catch {
      return { status: 'ignored' };
    }
  }

  private mutateAndRelease(
    ref: AutonomousTaskRef,
    act: () => AutonomousTaskMutationResult,
  ): void {
    const result = this.mutate(ref, act);
    if (isAutonomousTaskApplied(result) && isTerminalAutonomousTaskState(result.snapshot.state)) {
      this.releaseTaskLocalState(ref.taskId);
    }
  }

  private releaseTaskLocalState(taskId: string): void {
    this.tabState.releaseTask(taskId);
    for (const [approvalId, correlation] of this.byApprovalId) {
      if (correlation.taskRef.taskId === taskId) {
        this.byApprovalId.delete(approvalId);
      }
    }
  }
}
