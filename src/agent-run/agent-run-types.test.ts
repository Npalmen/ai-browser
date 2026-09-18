import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isTerminalAgentRunState,
  MAX_AGENT_LOOP_ACTION_ATTEMPTS,
  MAX_AGENT_LOOP_APPROVALS,
  MAX_AGENT_LOOP_MODEL_STEPS,
  TERMINAL_AGENT_RUN_STATES,
  toAgentRunRef,
  type AgentRunSnapshot,
  type AgentRunState,
} from './agent-run-types';

describe('AgentRun constants and terminal states', () => {
  it('locks exact conservative loop budgets', () => {
    assert.equal(MAX_AGENT_LOOP_MODEL_STEPS, 8);
    assert.equal(MAX_AGENT_LOOP_ACTION_ATTEMPTS, 6);
    assert.equal(MAX_AGENT_LOOP_APPROVALS, 2);
  });

  it('exposes the frozen terminal set and rejects non-terminal states', () => {
    assert.deepEqual([...TERMINAL_AGENT_RUN_STATES], [
      'completed',
      'cancelled',
      'blocked',
      'failed',
      'execution-state-unknown',
    ]);
    assert.equal(Object.isFrozen(TERMINAL_AGENT_RUN_STATES), true);
    for (const state of TERMINAL_AGENT_RUN_STATES) {
      assert.equal(isTerminalAgentRunState(state), true);
    }
    const live: AgentRunState[] = ['running', 'awaiting-approval'];
    for (const state of live) {
      assert.equal(isTerminalAgentRunState(state), false);
    }
  });

  it('builds a frozen correlation ref without copying instruction or counts', () => {
    const snapshot: AgentRunSnapshot = Object.freeze({
      runId: 'run-1',
      tabId: 'tab-1',
      generation: 3,
      instruction: 'do the thing',
      startedAt: 1,
      state: 'running',
      modelStepCount: 2,
      actionAttemptCount: 1,
      approvalCount: 0,
    });
    const ref = toAgentRunRef(snapshot);
    assert.deepEqual(ref, { runId: 'run-1', tabId: 'tab-1', generation: 3 });
    assert.equal(Object.isFrozen(ref), true);
    assert.equal('instruction' in ref, false);
  });
});
