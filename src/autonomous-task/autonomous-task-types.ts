import type { TabId } from '../shared/browser-types';

export const MAX_AUTONOMOUS_TASK_PLANNER_STEPS = 8;
export const MAX_AUTONOMOUS_TASK_CHILD_RUNS = 4;
export const MAX_AUTONOMOUS_TASK_OWNED_TABS = 3;
export const MAX_AUTONOMOUS_TASK_APPROVALS = 4;

export type AutonomousTaskId = string;

export type AutonomousTaskState =
  | 'planning'
  | 'running-subgoal'
  | 'awaiting-approval'
  | 'awaiting-user-input'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'blocked'
  | 'failed'
  | 'execution-state-unknown';

export const TERMINAL_AUTONOMOUS_TASK_STATES = Object.freeze([
  'completed',
  'cancelled',
  'blocked',
  'failed',
  'execution-state-unknown',
] as const satisfies ReadonlyArray<AutonomousTaskState>);

export type TerminalAutonomousTaskState = (typeof TERMINAL_AUTONOMOUS_TASK_STATES)[number];

export const ACTIVE_AUTONOMOUS_TASK_STATES = Object.freeze([
  'planning',
  'running-subgoal',
  'awaiting-approval',
  'awaiting-user-input',
] as const satisfies ReadonlyArray<AutonomousTaskState>);

export type ActiveAutonomousTaskState = (typeof ACTIVE_AUTONOMOUS_TASK_STATES)[number];

export function isTerminalAutonomousTaskState(
  state: AutonomousTaskState,
): state is TerminalAutonomousTaskState {
  return (TERMINAL_AUTONOMOUS_TASK_STATES as readonly AutonomousTaskState[]).includes(state);
}

export function isActiveAutonomousTaskState(
  state: AutonomousTaskState,
): state is ActiveAutonomousTaskState {
  return (ACTIVE_AUTONOMOUS_TASK_STATES as readonly AutonomousTaskState[]).includes(state);
}

export interface AutonomousTaskRef {
  readonly taskId: AutonomousTaskId;
  readonly generation: number;
}

export type AutonomousTaskBlockedReason =
  | 'TASK_LIMIT_REACHED'
  | 'TASK_NO_PROGRESS'
  | 'POLICY_BLOCKED'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'ACTION_STALE'
  | 'TAB_UNAVAILABLE'
  | 'TAB_OWNERSHIP_VIOLATION';

export type AutonomousTaskCancelledReason = 'USER_CANCELLED' | 'RUNTIME_DISPOSED';

export type AutonomousTaskFailedReason =
  | 'PLANNER_FAILED'
  | 'CHILD_RUN_FAILED'
  | 'TASK_INTERNAL_ERROR';

export type AutonomousTaskUnknownReason = 'EXECUTION_STATE_UNKNOWN';

export type AutonomousTaskCompletedReason = 'COMPLETED';

export type AutonomousTaskTerminalReason =
  | AutonomousTaskBlockedReason
  | AutonomousTaskCancelledReason
  | AutonomousTaskFailedReason
  | AutonomousTaskUnknownReason
  | AutonomousTaskCompletedReason;

export interface AutonomousTaskSnapshot {
  readonly taskId: AutonomousTaskId;
  readonly generation: number;
  readonly objective: string;
  readonly startedAt: number;
  readonly startingTabId: TabId;
  readonly state: AutonomousTaskState;
  readonly plannerStepCount: number;
  readonly childRunCount: number;
  readonly ownedTabCount: number;
  readonly taskApprovalCount: number;
  readonly terminalReason?: AutonomousTaskTerminalReason;
  readonly lastCompletedSubgoalFingerprint?: string;
}

export type AutonomousTaskRefStatus =
  | { readonly status: 'current'; readonly snapshot: AutonomousTaskSnapshot }
  | { readonly status: 'paused'; readonly snapshot: AutonomousTaskSnapshot }
  | { readonly status: 'terminal'; readonly snapshot: AutonomousTaskSnapshot }
  | { readonly status: 'superseded'; readonly snapshot: AutonomousTaskSnapshot }
  | { readonly status: 'missing' };

export type AutonomousTaskMutationResult =
  | { readonly status: 'applied'; readonly snapshot: AutonomousTaskSnapshot }
  | { readonly status: 'ignored' };

export function toAutonomousTaskRef(snapshot: AutonomousTaskSnapshot): AutonomousTaskRef {
  return Object.freeze({
    taskId: snapshot.taskId,
    generation: snapshot.generation,
  });
}

export function isAutonomousTaskApplied(
  result: AutonomousTaskMutationResult,
): result is Extract<AutonomousTaskMutationResult, { status: 'applied' }> {
  return result.status === 'applied';
}
