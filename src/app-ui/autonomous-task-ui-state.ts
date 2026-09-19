import {
  type AutonomousTaskEvent,
  type AutonomousTaskView,
  type AutonomousTaskViewState,
} from '../shared/autonomous-task-types';
import type { TabId } from '../shared/browser-types';

const TERMINAL_STATES = new Set<AutonomousTaskViewState>([
  'completed',
  'cancelled',
  'blocked',
  'failed',
  'execution-state-unknown',
]);

export interface AutonomousTaskUiState {
  tasks: AutonomousTaskView[];
  startError?: string;
  replyDraftByTaskId: Record<string, string>;
}

export function emptyAutonomousTaskUiState(): AutonomousTaskUiState {
  return {
    tasks: [],
    replyDraftByTaskId: {},
  };
}

export function autonomousTaskUiFromViews(
  views: readonly AutonomousTaskView[],
): AutonomousTaskUiState {
  return {
    tasks: [...views],
    replyDraftByTaskId: {},
  };
}

export function applyAutonomousTaskEvent(
  state: AutonomousTaskUiState,
  event: AutonomousTaskEvent,
): AutonomousTaskUiState {
  const nextTask = event.task;
  const index = state.tasks.findIndex((task) => task.taskId === nextTask.taskId);
  if (index < 0) {
    return {
      ...state,
      startError: undefined,
      tasks: [...state.tasks, nextTask],
    };
  }

  const current = state.tasks[index];
  if (!shouldReplaceTask(current, event)) {
    return state;
  }

  const tasks = state.tasks.slice();
  tasks[index] = nextTask;
  return {
    ...state,
    startError: undefined,
    tasks,
  };
}

export function applyAutonomousTaskStartFailure(
  state: AutonomousTaskUiState,
  message: string,
): AutonomousTaskUiState {
  return {
    ...state,
    startError: message,
  };
}

export function clearAutonomousTaskStartError(state: AutonomousTaskUiState): AutonomousTaskUiState {
  if (state.startError === undefined) {
    return state;
  }
  return {
    ...state,
    startError: undefined,
  };
}

export function setAutonomousTaskReplyDraft(
  state: AutonomousTaskUiState,
  taskId: string,
  draft: string,
): AutonomousTaskUiState {
  return {
    ...state,
    replyDraftByTaskId: {
      ...state.replyDraftByTaskId,
      [taskId]: draft,
    },
  };
}

export function hasAutonomousTaskAttention(state: AutonomousTaskUiState): boolean {
  return state.tasks.some(
    (task) => task.attention === 'approval' || task.attention === 'user-input',
  );
}

export function ownedTaskTabIds(state: AutonomousTaskUiState): ReadonlySet<TabId> {
  const ids = new Set<TabId>();
  for (const task of state.tasks) {
    if (TERMINAL_STATES.has(task.state)) {
      continue;
    }
    for (const tabId of task.ownedTabIds) {
      ids.add(tabId);
    }
  }
  return ids;
}

export function findAwaitingUserInputTask(
  state: AutonomousTaskUiState,
): AutonomousTaskView | undefined {
  return state.tasks.find((task) => task.state === 'awaiting-user-input');
}

export function findActiveAutonomousTask(
  state: AutonomousTaskUiState,
): AutonomousTaskView | undefined {
  return state.tasks.find(
    (task) =>
      task.state === 'planning' ||
      task.state === 'running-subgoal' ||
      task.state === 'awaiting-approval' ||
      task.state === 'awaiting-user-input',
  );
}

function shouldReplaceTask(current: AutonomousTaskView, event: AutonomousTaskEvent): boolean {
  if (TERMINAL_STATES.has(current.state)) {
    return false;
  }
  if (current.state === 'paused' && event.type === 'autonomous-task-progress') {
    return false;
  }
  return true;
}
