import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAutonomousTaskAuditEvent,
  InMemoryAutonomousTaskAuditSink,
  type AutonomousTaskAuditEvent,
} from './autonomous-task-audit';
import type { AutonomousTaskSnapshot } from './autonomous-task-types';

function snapshot(overrides: Partial<AutonomousTaskSnapshot> = {}): AutonomousTaskSnapshot {
  return Object.freeze({
    taskId: 'task-1',
    generation: 1,
    objective: 'Find the invoice and prepare it for download',
    startedAt: 1_000,
    startingTabId: 'tab-secret',
    state: 'planning',
    plannerStepCount: 1,
    childRunCount: 0,
    ownedTabCount: 1,
    taskApprovalCount: 0,
    ...overrides,
  });
}

const FORBIDDEN_AUDIT_TEXT = [
  'Find the invoice and prepare it for download',
  'tab-secret',
  'task-tab-1',
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
  'abc123fingerprint',
];

describe('AutonomousTask audit sink', () => {
  it('clones frozen metadata-only events and ignores later external mutation', () => {
    const sink = new InMemoryAutonomousTaskAuditSink();
    sink.append(buildAutonomousTaskAuditEvent('task-started', snapshot(), 1_000));

    const events = sink.getEvents();
    assert.equal(events.length, 1);
    assert.equal(Object.isFrozen(events), true);
    assert.equal(Object.isFrozen(events[0]), true);
    assert.equal(events[0].eventType, 'task-started');
    assert.equal(events[0].taskId, 'task-1');
    assert.equal('objective' in events[0], false);
    assert.equal('startingTabId' in events[0], false);

    assert.throws(() => {
      (events as AutonomousTaskAuditEvent[]).push(events[0]);
    });
    assert.throws(() => {
      (events[0] as { state: string }).state = 'failed';
    });
    assert.equal(sink.getEvents().length, 1);
    assert.equal(sink.getEvents()[0].state, 'planning');
  });

  it('never copies objective, fingerprint, tab, or authority fields into audit events', () => {
    const sink = new InMemoryAutonomousTaskAuditSink();
    const event = buildAutonomousTaskAuditEvent(
      'task-terminal',
      snapshot({
        state: 'blocked',
        terminalReason: 'TASK_NO_PROGRESS',
        lastCompletedSubgoalFingerprint: 'abc123fingerprint',
      }),
      2_000,
    );
    sink.append(event);
    const serialized = JSON.stringify(sink.getEvents());
    for (const needle of FORBIDDEN_AUDIT_TEXT) {
      assert.equal(serialized.includes(needle), false, `leaked ${needle}`);
    }
    assert.equal(serialized.includes('objective'), false);
    assert.equal(serialized.includes('lastCompletedSubgoalFingerprint'), false);
    assert.equal(serialized.includes('targetId'), false);
    assert.equal(serialized.includes('approvalId'), false);
    assert.equal(sink.getEvents()[0].terminalReason, 'TASK_NO_PROGRESS');
  });

  it('clear empties history without reviving previous snapshots', () => {
    const sink = new InMemoryAutonomousTaskAuditSink();
    sink.append(buildAutonomousTaskAuditEvent('task-started', snapshot(), 1_000));
    const previous = sink.getEvents();
    sink.clear();
    assert.equal(sink.getEvents().length, 0);
    assert.equal(previous.length, 1);
  });
});
