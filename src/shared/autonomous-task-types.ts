import type { AiSafeError } from './ai-types';
import type { TabId } from './browser-types';

export const MAX_AUTONOMOUS_TASK_UI_QUESTION_CHARS = 1000;
export const MAX_AUTONOMOUS_TASK_OBJECTIVE_CHARS = 4000;
export const MAX_AUTONOMOUS_TASK_REPLY_CHARS = 4000;
export const MAX_AUTONOMOUS_TASK_ANSWER_CHARS = 4000;
export const MAX_AUTONOMOUS_TASK_ID_CHARS = 128;

export const AUTONOMOUS_TASK_EXECUTION_UNKNOWN_COPY =
  'The last approved action may have occurred.\nThe task was stopped to avoid repeating it.';

export const AUTONOMOUS_TASK_VIEW_LIMITS = Object.freeze({
  plannerSteps: 8,
  childRuns: 4,
  ownedTabs: 3,
  approvals: 4,
});

export type AutonomousTaskViewState =
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

export type AutonomousTaskViewTerminalReason =
  | 'TASK_LIMIT_REACHED'
  | 'TASK_NO_PROGRESS'
  | 'POLICY_BLOCKED'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'ACTION_STALE'
  | 'TAB_UNAVAILABLE'
  | 'TAB_OWNERSHIP_VIOLATION'
  | 'USER_CANCELLED'
  | 'RUNTIME_DISPOSED'
  | 'PLANNER_FAILED'
  | 'CHILD_RUN_FAILED'
  | 'TASK_INTERNAL_ERROR'
  | 'EXECUTION_STATE_UNKNOWN'
  | 'COMPLETED';

export interface AutonomousTaskCurrentSubgoalView {
  readonly tabAlias: string;
  readonly ordinal: number;
}

export interface AutonomousTaskView {
  readonly taskId: string;
  readonly state: AutonomousTaskViewState;
  readonly plannerStepCount: number;
  readonly childRunCount: number;
  readonly ownedTabCount: number;
  readonly taskApprovalCount: number;
  readonly limits: {
    readonly plannerSteps: 8;
    readonly childRuns: 4;
    readonly ownedTabs: 3;
    readonly approvals: 4;
  };
  readonly ownedTabIds: readonly TabId[];
  readonly currentSubgoal?: AutonomousTaskCurrentSubgoalView;
  readonly attention?: 'approval' | 'user-input';
  readonly attentionTabId?: TabId;
  readonly terminalReason?: AutonomousTaskViewTerminalReason;
  readonly question?: string;
  readonly completedAnswer?: string;
}

export type AutonomousTaskEventType =
  | 'autonomous-task-started'
  | 'autonomous-task-progress'
  | 'autonomous-task-awaiting-approval'
  | 'autonomous-task-awaiting-user-input'
  | 'autonomous-task-paused'
  | 'autonomous-task-resumed'
  | 'autonomous-task-completed'
  | 'autonomous-task-blocked'
  | 'autonomous-task-failed'
  | 'autonomous-task-cancelled'
  | 'autonomous-task-execution-state-unknown';

export interface AutonomousTaskEvent {
  readonly type: AutonomousTaskEventType;
  readonly task: AutonomousTaskView;
}

export interface AutonomousTaskStartInput {
  readonly objective: string;
}

export interface AutonomousTaskIdInput {
  readonly taskId: string;
}

export interface AutonomousTaskReplyInput {
  readonly taskId: string;
  readonly reply: string;
}

export type AutonomousTaskStartResult =
  | {
      readonly ok: true;
      readonly task: AutonomousTaskView;
    }
  | {
      readonly ok: false;
      readonly error: AiSafeError;
    };

export type AutonomousTaskControlResult =
  | {
      readonly ok: true;
      readonly task: AutonomousTaskView;
    }
  | {
      readonly ok: false;
      readonly error: AiSafeError;
      readonly ignored?: true;
    };

export type AutonomousTaskGetStateResult =
  | {
      readonly ok: true;
      readonly tasks: readonly AutonomousTaskView[];
    }
  | {
      readonly ok: false;
      readonly error: AiSafeError;
    };

export type AiPanelMode = 'read' | 'interact' | 'delegate';

export function autonomousTaskTerminalCopy(
  reason: AutonomousTaskViewTerminalReason | undefined,
): string {
  switch (reason) {
    case 'TASK_LIMIT_REACHED':
      return 'Task reached its autonomous limit.';
    case 'TASK_NO_PROGRESS':
      return 'Task stopped because it was repeating the same subgoal.';
    case 'APPROVAL_REJECTED':
      return 'Task stopped because the action was not approved.';
    case 'APPROVAL_EXPIRED':
      return 'Task stopped because the approval expired.';
    case 'ACTION_STALE':
      return 'Task stopped because the approved action became stale.';
    case 'POLICY_BLOCKED':
      return 'Task stopped because an action was not allowed.';
    case 'TAB_UNAVAILABLE':
    case 'TAB_OWNERSHIP_VIOLATION':
      return 'Task stopped because a required task tab is unavailable.';
    case 'PLANNER_FAILED':
      return 'Task stopped because planning failed.';
    case 'CHILD_RUN_FAILED':
      return 'Task stopped because a subgoal failed.';
    case 'TASK_INTERNAL_ERROR':
      return 'Task stopped because of an internal error.';
    case 'EXECUTION_STATE_UNKNOWN':
      return AUTONOMOUS_TASK_EXECUTION_UNKNOWN_COPY;
    case 'USER_CANCELLED':
    case 'RUNTIME_DISPOSED':
      return 'Task cancelled.';
    case 'COMPLETED':
      return 'Task completed.';
    default:
      return 'Task ended.';
  }
}

