import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyAutonomousTaskEvent,
  applyAutonomousTaskStartFailure,
  emptyAutonomousTaskUiState,
  hasAutonomousTaskAttention,
  ownedTaskTabIds,
} from './autonomous-task-ui-state';
import type { AutonomousTaskEvent, AutonomousTaskView } from '../shared/autonomous-task-types';

function view(overrides: Partial<AutonomousTaskView> & Pick<AutonomousTaskView, 'taskId' | 'state'>): AutonomousTaskView {
  return {
    plannerStepCount: 0,
    childRunCount: 0,
    ownedTabCount: 1,
    taskApprovalCount: 0,
    limits: { plannerSteps: 8, childRuns: 4, ownedTabs: 3, approvals: 4 },
    ownedTabIds: ['tab-a'],
    ...overrides,
  };
}

function event(
  type: AutonomousTaskEvent['type'],
  task: AutonomousTaskView,
): AutonomousTaskEvent {
  return { type, task };
}

describe('autonomous task UI state', () => {
  it('tracks multiple tasks and does not resurrect a terminal task', () => {
    let state = emptyAutonomousTaskUiState();
    state = applyAutonomousTaskEvent(
      state,
      event('autonomous-task-started', view({ taskId: 'task-1', state: 'planning' })),
    );
    state = applyAutonomousTaskEvent(
      state,
      event('autonomous-task-paused', view({ taskId: 'task-1', state: 'paused', ownedTabIds: ['tab-a'] })),
    );
    state = applyAutonomousTaskEvent(
      state,
      event('autonomous-task-started', view({ taskId: 'task-2', state: 'planning', ownedTabIds: ['tab-b'] })),
    );
    assert.equal(state.tasks.length, 2);
    assert.deepEqual([...ownedTaskTabIds(state)], ['tab-a', 'tab-b']);

    state = applyAutonomousTaskEvent(
      state,
      event(
        'autonomous-task-execution-state-unknown',
        view({ taskId: 'task-2', state: 'execution-state-unknown', ownedTabIds: [] }),
      ),
    );
    state = applyAutonomousTaskEvent(
      state,
      event('autonomous-task-progress', view({ taskId: 'task-2', state: 'planning' })),
    );
    assert.equal(state.tasks.find((task) => task.taskId === 'task-2')?.state, 'execution-state-unknown');

    state = applyAutonomousTaskEvent(
      state,
      event('autonomous-task-progress', view({ taskId: 'task-1', state: 'planning' })),
    );
    assert.equal(state.tasks.find((task) => task.taskId === 'task-1')?.state, 'paused');
  });

  it('records sanitized start errors and attention from awaiting states', () => {
    let state = applyAutonomousTaskStartFailure(emptyAutonomousTaskUiState(), 'The AI request was invalid.');
    assert.equal(state.startError, 'The AI request was invalid.');
    state = applyAutonomousTaskEvent(
      state,
      event(
        'autonomous-task-awaiting-approval',
        view({
          taskId: 'task-1',
          state: 'awaiting-approval',
          attention: 'approval',
          attentionTabId: 'tab-a',
        }),
      ),
    );
    assert.equal(state.startError, undefined);
    assert.equal(hasAutonomousTaskAttention(state), true);
  });
});
