import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isActiveAutonomousTaskState,
  isTerminalAutonomousTaskState,
  MAX_AUTONOMOUS_TASK_APPROVALS,
  MAX_AUTONOMOUS_TASK_CHILD_RUNS,
  MAX_AUTONOMOUS_TASK_OWNED_TABS,
  MAX_AUTONOMOUS_TASK_PLANNER_STEPS,
  TERMINAL_AUTONOMOUS_TASK_STATES,
  toAutonomousTaskRef,
  type AutonomousTaskSnapshot,
  type AutonomousTaskState,
} from './autonomous-task-types';

describe('AutonomousTask constants and terminal states', () => {
  it('locks exact conservative task budgets', () => {
    assert.equal(MAX_AUTONOMOUS_TASK_PLANNER_STEPS, 8);
    assert.equal(MAX_AUTONOMOUS_TASK_CHILD_RUNS, 4);
    assert.equal(MAX_AUTONOMOUS_TASK_OWNED_TABS, 3);
    assert.equal(MAX_AUTONOMOUS_TASK_APPROVALS, 4);
  });

  it('exposes the frozen terminal set and rejects non-terminal states', () => {
    assert.deepEqual([...TERMINAL_AUTONOMOUS_TASK_STATES], [
      'completed',
      'cancelled',
      'blocked',
      'failed',
      'execution-state-unknown',
    ]);
    assert.equal(Object.isFrozen(TERMINAL_AUTONOMOUS_TASK_STATES), true);
    for (const state of TERMINAL_AUTONOMOUS_TASK_STATES) {
      assert.equal(isTerminalAutonomousTaskState(state), true);
      assert.equal(isActiveAutonomousTaskState(state), false);
    }
    const active: AutonomousTaskState[] = [
      'planning',
      'running-subgoal',
      'awaiting-approval',
      'awaiting-user-input',
    ];
    for (const state of active) {
      assert.equal(isTerminalAutonomousTaskState(state), false);
      assert.equal(isActiveAutonomousTaskState(state), true);
    }
    assert.equal(isTerminalAutonomousTaskState('paused'), false);
    assert.equal(isActiveAutonomousTaskState('paused'), false);
  });

  it('builds a frozen correlation ref without copying objective or counts', () => {
    const snapshot: AutonomousTaskSnapshot = Object.freeze({
      taskId: 'task-1',
      generation: 3,
      objective: 'compare prices',
      startedAt: 1,
      startingTabId: 'tab-1',
      state: 'planning',
      plannerStepCount: 2,
      childRunCount: 1,
      ownedTabCount: 1,
      taskApprovalCount: 0,
    });
    const ref = toAutonomousTaskRef(snapshot);
    assert.deepEqual(ref, { taskId: 'task-1', generation: 3 });
    assert.equal(Object.isFrozen(ref), true);
    assert.equal('objective' in ref, false);
    assert.equal('plannerStepCount' in ref, false);
  });
});
