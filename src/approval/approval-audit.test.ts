import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApprovalManager } from './approval-manager';
import { ApprovalAuditRecorder } from './approval-audit-recorder';
import {
  buildApprovalPresentedAuditEvent,
  buildPreparedApprovalAuditEvent,
  InMemoryApprovalAuditSink,
  type ApprovalAuditEvent,
} from './approval-audit';
import { ApprovalError } from '../shared/approval-errors';
import type { PreparedAction } from '../shared/approval-types';

function preparedAction(overrides: Partial<PreparedAction> = {}): PreparedAction {
  return Object.freeze({
    preparedActionId: 'prep-1',
    approvalId: 'appr-1',
    kind: 'click',
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
    targetId: 'target-1',
    category: 'submit',
    summary: Object.freeze({ title: 'Submit form' }),
    createdAt: 1_000,
    expiresAt: 121_000,
    state: 'pending',
    ...overrides,
  });
}

describe('approval audit', () => {
  it('records a prepared event with false stage facts and no executionId', () => {
    const sink = new InMemoryApprovalAuditSink();
    const action = preparedAction();
    sink.append(
      buildPreparedApprovalAuditEvent({
        action,
        facts: {
          grantIssued: false,
          grantClaimed: false,
          adapterPrimitiveInvoked: false,
          postObservationSucceeded: false,
        },
      }),
    );

    const [event] = sink.getEvents();
    assert.equal(event.eventType, 'prepared');
    assert.equal(event.timestamp, 1_000);
    assert.equal(event.executionId, undefined);
    assert.deepEqual(
      {
        grantIssued: event.grantIssued,
        grantClaimed: event.grantClaimed,
        adapterPrimitiveInvoked: event.adapterPrimitiveInvoked,
        postObservationSucceeded: event.postObservationSucceeded,
      },
      {
        grantIssued: false,
        grantClaimed: false,
        adapterPrimitiveInvoked: false,
        postObservationSucceeded: false,
      },
    );
    assert.equal(Object.isFrozen(event), true);
  });

  it('returns immutable event snapshots from getEvents', () => {
    const sink = new InMemoryApprovalAuditSink();
    const action = preparedAction();
    sink.append(
      buildPreparedApprovalAuditEvent({
        action,
        facts: {
          grantIssued: false,
          grantClaimed: false,
          adapterPrimitiveInvoked: false,
          postObservationSucceeded: false,
        },
      }),
    );

    const events = sink.getEvents();
    try {
      (events as ApprovalAuditEvent[]).push({
        eventType: 'prepared',
        timestamp: 2,
        preparedActionId: 'tampered',
        approvalId: 'tampered',
        tabId: 'tab-x',
        observationId: 'obs-x',
        documentRevision: 'rev-x',
        targetId: 'target-x',
        category: 'submit',
        grantIssued: false,
        grantClaimed: false,
        adapterPrimitiveInvoked: false,
        postObservationSucceeded: false,
      });
    } catch {
      // frozen array throws in strict mode
    }

    assert.equal(sink.getEvents().length, 1);
    assert.equal(sink.getEvents()[0].preparedActionId, 'prep-1');
  });

  it('records approval-presented from manager-owned snapshot only', () => {
    const manager = new ApprovalManager({
      now: () => 5_000,
      generatePreparedActionId: () => 'prep-1',
      generateApprovalId: () => 'appr-1',
    });
    manager.prepare({
      tabId: 'tab-1',
      observationId: 'obs-1',
      documentRevision: 'rev-1',
      targetId: 'target-1',
      category: 'send',
      summary: { title: 'Send' },
    });
    const audit = new InMemoryApprovalAuditSink();
    const recorder = new ApprovalAuditRecorder({
      manager,
      audit,
      now: () => 6_000,
    });

    const event = recorder.recordApprovalPresented('appr-1');
    assert.equal(event.eventType, 'approval-presented');
    assert.equal(event.timestamp, 6_000);
    assert.equal(event.category, 'send');
    assert.equal(event.targetId, 'target-1');
    assert.equal(audit.getEvents().length, 1);
  });

  it('allows approval-presented at expiresAt - 1 and rejects at expiresAt', () => {
    const clock = { now: 5_000 };
    const manager = new ApprovalManager({
      now: () => clock.now,
      generatePreparedActionId: () => 'prep-1',
      generateApprovalId: () => 'appr-1',
    });
    const action = manager.prepare({
      tabId: 'tab-1',
      observationId: 'obs-1',
      documentRevision: 'rev-1',
      targetId: 'target-1',
      category: 'send',
      summary: { title: 'Send' },
    });
    const audit = new InMemoryApprovalAuditSink();
    const recorder = new ApprovalAuditRecorder({
      manager,
      audit,
      now: () => clock.now,
    });

    clock.now = action.expiresAt - 1;
    const presented = recorder.recordApprovalPresented(action.approvalId);
    assert.equal(presented.eventType, 'approval-presented');
    assert.equal(presented.timestamp, action.expiresAt - 1);
    assert.equal(audit.getEvents().length, 1);

    clock.now = action.expiresAt;
    const laterAudit = new InMemoryApprovalAuditSink();
    const laterRecorder = new ApprovalAuditRecorder({
      manager,
      audit: laterAudit,
      now: () => clock.now,
    });
    assert.throws(
      () => laterRecorder.recordApprovalPresented(action.approvalId),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalError);
        assert.equal(error.code, 'APPROVAL_EXPIRED');
        return true;
      },
    );
    assert.equal(laterAudit.getEvents().length, 0);
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'pending');
  });

  it('does not include summary or page text in audit serialization', () => {
    const event = buildApprovalPresentedAuditEvent({
      snapshot: {
        action: preparedAction({
          summary: Object.freeze({
            title: 'Confirm purchase',
            description: 'V4_PROMPT_INJECTION_CANARY',
            origin: 'https://shop.test',
          }),
        }),
        facts: {
          grantIssued: false,
          grantClaimed: false,
          adapterPrimitiveInvoked: false,
          postObservationSucceeded: false,
        },
      },
      timestamp: 2_000,
    });

    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes('Confirm purchase'), false);
    assert.equal(serialized.includes('V4_PROMPT_INJECTION_CANARY'), false);
    assert.equal(serialized.includes('shop.test'), false);
    assert.equal(serialized.includes('node.name'), false);
    assert.equal(serialized.includes('backendNodeId'), false);
  });
});
