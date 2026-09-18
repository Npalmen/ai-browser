import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAgentRunAuditEvent,
  InMemoryAgentRunAuditSink,
  type AgentRunAuditEvent,
} from './agent-run-audit';
import type { AgentRunSnapshot } from './agent-run-types';

function snapshot(overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
  return Object.freeze({
    runId: 'run-1',
    tabId: 'tab-1',
    generation: 1,
    instruction: 'Open settings and enable dark mode',
    startedAt: 1_000,
    state: 'running',
    modelStepCount: 1,
    actionAttemptCount: 0,
    approvalCount: 0,
    ...overrides,
  });
}

const FORBIDDEN_AUDIT_TEXT = [
  'Open settings and enable dark mode',
  'target-secret',
  'option-secret',
  'document-rev',
  'backend-node',
  'frame-secret',
  'typed-password',
  'approval-secret',
  'prepared-secret',
  'execution-secret',
  'InteractionGrant',
  'ExecuteGrant',
];

describe('AgentRun audit sink', () => {
  it('clones frozen metadata-only events and ignores later external mutation', () => {
    const sink = new InMemoryAgentRunAuditSink();
    sink.append(buildAgentRunAuditEvent('run-started', snapshot(), 1_000));

    const events = sink.getEvents();
    assert.equal(events.length, 1);
    assert.equal(Object.isFrozen(events), true);
    assert.equal(Object.isFrozen(events[0]), true);
    assert.equal(events[0].eventType, 'run-started');
    assert.equal(events[0].runId, 'run-1');
    assert.equal('instruction' in events[0], false);

    assert.throws(() => {
      (events as AgentRunAuditEvent[]).push(events[0]);
    });
    assert.throws(() => {
      (events[0] as { state: string }).state = 'failed';
    });
    assert.equal(sink.getEvents().length, 1);
    assert.equal(sink.getEvents()[0].state, 'running');
  });

  it('never copies instruction, page, target, or authority fields into audit events', () => {
    const sink = new InMemoryAgentRunAuditSink();
    const event = buildAgentRunAuditEvent(
      'run-terminal',
      snapshot({
        state: 'blocked',
        terminalReason: 'STEP_LIMIT_REACHED',
        lastSuccessfulActionFingerprint: 'abc123',
      }),
      2_000,
    );
    sink.append(event);
    const serialized = JSON.stringify(sink.getEvents());
    for (const needle of FORBIDDEN_AUDIT_TEXT) {
      assert.equal(serialized.includes(needle), false, `leaked ${needle}`);
    }
    assert.equal(serialized.includes('instruction'), false);
    assert.equal(serialized.includes('lastSuccessfulActionFingerprint'), false);
    assert.equal(serialized.includes('targetId'), false);
    assert.equal(serialized.includes('approvalId'), false);
    assert.equal(sink.getEvents()[0].terminalReason, 'STEP_LIMIT_REACHED');
  });

  it('clear empties history without reviving previous snapshots', () => {
    const sink = new InMemoryAgentRunAuditSink();
    sink.append(buildAgentRunAuditEvent('run-started', snapshot(), 1_000));
    const previous = sink.getEvents();
    sink.clear();
    assert.equal(sink.getEvents().length, 0);
    assert.equal(previous.length, 1);
  });
});
