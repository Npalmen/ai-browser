import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import { InMemoryApprovalAuditSink } from '../approval/approval-audit';
import { ApprovalManager } from '../approval/approval-manager';
import type { ApprovalEvent } from '../shared/approval-types';
import type { PreparePreparedActionInput } from '../shared/approval-types';
import { ApprovalController } from './approval-controller';

const LEAK_TARGET = 'V4_TARGET_HANDLE_DO_NOT_LEAK';
const LEAK_OBSERVATION = 'V4_OBSERVATION_HANDLE_DO_NOT_LEAK';
const LEAK_REVISION = 'V4_REVISION_HANDLE_DO_NOT_LEAK';
const LEAK_PREPARED = 'V4_PREPARED_INTERNAL_DO_NOT_LEAK';

interface Harness {
  manager: ApprovalManager;
  audit: InMemoryApprovalAuditSink;
  controller: ApprovalController;
  events: ApprovalEvent[];
  now: number;
  setNow(value: number): void;
}

function createHarness(startNow = 1_000): Harness {
  const ids = { prepared: 0, approval: 0 };
  const state = { now: startNow };
  const manager = new ApprovalManager({
    now: () => state.now,
    generatePreparedActionId: () => `prep-${++ids.prepared}`,
    generateApprovalId: () => `appr-${++ids.approval}`,
  });
  const audit = new InMemoryApprovalAuditSink();
  const events: ApprovalEvent[] = [];
  const controller = new ApprovalController({
    manager,
    auditRecorder: new ApprovalAuditRecorder({ manager, audit, now: () => state.now }),
    emit: (event) => {
      events.push(event);
    },
  });
  return {
    manager,
    audit,
    controller,
    events,
    now: startNow,
    setNow(value: number) {
      state.now = value;
    },
  };
}

function prepareInput(overrides: Partial<PreparePreparedActionInput> = {}): PreparePreparedActionInput {
  return {
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
    targetId: 'target-1',
    category: 'submit',
    summary: { title: 'Submit form' },
    ...overrides,
  };
}

describe('ApprovalController', () => {
  it('approves a pending action without claiming an ExecuteGrant', () => {
    const harness = createHarness();
    const action = harness.manager.prepare(prepareInput());
    const result = harness.controller.decide({ approvalId: action.approvalId, decision: 'approve' });

    assert.deepEqual(result, {
      ok: true,
      approvalId: action.approvalId,
      decision: 'approve',
      state: 'approved',
    });
    const snapshot = harness.manager.getSnapshot(action.approvalId);
    assert.equal(snapshot?.action.state, 'approved');
    assert.deepEqual(snapshot?.facts, {
      grantIssued: true,
      grantClaimed: false,
      adapterPrimitiveInvoked: false,
      postObservationSucceeded: false,
    });
    assert.equal(snapshot?.executionGrant, undefined);
    assert.equal(harness.events.length, 1);
    assert.deepEqual(harness.events[0], {
      type: 'approval-resolved',
      approvalId: action.approvalId,
      tabId: 'tab-1',
      decision: 'approve',
      state: 'approved',
    });
    assert.equal(harness.audit.getEvents().length, 1);
    assert.equal(harness.audit.getEvents()[0].eventType, 'approved');
    assert.equal(harness.audit.getEvents()[0].timestamp, snapshot?.decision?.decidedAt);
    assert.equal(harness.audit.getEvents()[0].grantIssued, true);
    assert.equal(harness.audit.getEvents()[0].grantClaimed, false);
    assert.equal(harness.audit.getEvents()[0].executionId, undefined);
  });

  it('rejects a pending action without a grant', () => {
    const harness = createHarness();
    const action = harness.manager.prepare(prepareInput());
    const result = harness.controller.decide({ approvalId: action.approvalId, decision: 'reject' });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.state, 'rejected');
      assert.equal(result.decision, 'reject');
    }
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'rejected');
    assert.equal(harness.manager.getSnapshot(action.approvalId)?.executionGrant, undefined);
    assert.equal(harness.events[0]?.type, 'approval-resolved');
    if (harness.events[0]?.type === 'approval-resolved') {
      assert.equal(harness.events[0].decision, 'reject');
      assert.equal(harness.events[0].state, 'rejected');
    }
    assert.equal(harness.audit.getEvents()[0]?.eventType, 'rejected');
    assert.equal(harness.audit.getEvents()[0]?.grantIssued, false);
  });

  it('expires a pending approval at decide time', () => {
    const harness = createHarness(1_000);
    const action = harness.manager.prepare(prepareInput());
    harness.setNow(action.expiresAt);
    const result = harness.controller.decide({ approvalId: action.approvalId, decision: 'approve' });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'APPROVAL_EXPIRED');
      assert.equal(result.error.message, 'This approval has expired.');
    }
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'expired');
    assert.equal(harness.manager.getSnapshot(action.approvalId)?.executionGrant, undefined);
    assert.equal(harness.events.length, 1);
    assert.deepEqual(harness.events[0], {
      type: 'approval-expired',
      approvalId: action.approvalId,
      tabId: 'tab-1',
    });
    assert.equal(harness.audit.getEvents()[0]?.eventType, 'expired');
    assert.equal(harness.events.some((event) => event.type === 'approval-resolved'), false);
  });

  it('returns stale without a successful resolution', () => {
    const harness = createHarness();
    const action = harness.manager.prepare(prepareInput());
    harness.manager.markStale(action.approvalId);
    const result = harness.controller.decide({ approvalId: action.approvalId, decision: 'approve' });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'APPROVAL_STALE');
    }
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'stale');
    assert.equal(harness.events.length, 1);
    assert.equal(harness.events[0]?.type, 'approval-stale');
    assert.equal(harness.audit.getEvents().length, 0);
    assert.equal(harness.manager.getSnapshot(action.approvalId)?.executionGrant, undefined);
  });

  it('rejects duplicate decisions after a winning approve', () => {
    const harness = createHarness();
    const action = harness.manager.prepare(prepareInput());
    const first = harness.controller.decide({ approvalId: action.approvalId, decision: 'approve' });
    const secondApprove = harness.controller.decide({ approvalId: action.approvalId, decision: 'approve' });
    const secondReject = harness.controller.decide({ approvalId: action.approvalId, decision: 'reject' });

    assert.equal(first.ok, true);
    assert.equal(secondApprove.ok, false);
    assert.equal(secondReject.ok, false);
    if (!secondApprove.ok) {
      assert.equal(secondApprove.error.code, 'APPROVAL_ALREADY_DECIDED');
    }
    if (!secondReject.ok) {
      assert.equal(secondReject.error.code, 'APPROVAL_ALREADY_DECIDED');
    }
    assert.equal(harness.events.length, 1);
    assert.equal(harness.audit.getEvents().length, 1);
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'approved');
  });

  it('lets exactly one of competing controller decisions win', async () => {
    const harness = createHarness();
    const action = harness.manager.prepare(prepareInput());
    const results = await Promise.all([
      Promise.resolve().then(() =>
        harness.controller.decide({ approvalId: action.approvalId, decision: 'approve' }),
      ),
      Promise.resolve().then(() =>
        harness.controller.decide({ approvalId: action.approvalId, decision: 'reject' }),
      ),
    ]);

    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    if (!failures[0].ok) {
      assert.equal(failures[0].error.code, 'APPROVAL_ALREADY_DECIDED');
    }
    const state = harness.manager.getByApprovalId(action.approvalId)?.state;
    assert.ok(state === 'approved' || state === 'rejected');
    assert.equal(harness.events.filter((event) => event.type === 'approval-resolved').length, 1);
    assert.equal(harness.audit.getEvents().length, 1);
  });

  it('does not leak internal authority handles in renderer events or results', () => {
    const harness = createHarness();
    const action = harness.manager.prepare(
      prepareInput({
        tabId: 'tab-safe',
        observationId: LEAK_OBSERVATION,
        documentRevision: LEAK_REVISION,
        targetId: LEAK_TARGET,
      }),
    );
    const managerAction = harness.manager.getByApprovalId(action.approvalId);
    assert.equal(managerAction?.preparedActionId.startsWith('prep-'), true);

    const leakingManager = new ApprovalManager({
      now: () => 1_000,
      generatePreparedActionId: () => LEAK_PREPARED,
      generateApprovalId: () => 'appr-safe',
    });
    const leakingAudit = new InMemoryApprovalAuditSink();
    const leakingEvents: ApprovalEvent[] = [];
    const leakingController = new ApprovalController({
      manager: leakingManager,
      auditRecorder: new ApprovalAuditRecorder({ manager: leakingManager, audit: leakingAudit }),
      emit: (event) => leakingEvents.push(event),
    });
    leakingManager.prepare(
      prepareInput({
        tabId: 'tab-safe',
        observationId: LEAK_OBSERVATION,
        documentRevision: LEAK_REVISION,
        targetId: LEAK_TARGET,
      }),
    );
    const result = leakingController.decide({ approvalId: 'appr-safe', decision: 'approve' });
    const serialized = `${JSON.stringify(result)}\n${JSON.stringify(leakingEvents)}`;

    for (const needle of [
      LEAK_TARGET,
      LEAK_OBSERVATION,
      LEAK_REVISION,
      LEAK_PREPARED,
      'targetId',
      'observationId',
      'documentRevision',
      'preparedActionId',
      'executionId',
      'grant',
      'authority',
      'backendNodeId',
      'proposal',
    ]) {
      assert.equal(serialized.includes(needle), false, `leaked ${needle}`);
    }
    assert.equal(serialized.includes('appr-safe'), true);
    assert.equal(serialized.includes('tab-safe'), true);
  });

  it('keeps a committed approve when the audit sink throws', () => {
    const manager = new ApprovalManager({
      now: () => 1_000,
      generatePreparedActionId: () => 'prep-1',
      generateApprovalId: () => 'appr-1',
    });
    const action = manager.prepare(prepareInput());
    const events: ApprovalEvent[] = [];
    const controller = new ApprovalController({
      manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager,
        audit: {
          append() {
            throw new Error('audit sink unavailable');
          },
          getEvents() {
            return [];
          },
          clear() {},
        },
      }),
      emit: (event) => {
        events.push(event);
      },
    });

    const result = controller.decide({ approvalId: action.approvalId, decision: 'approve' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decision, 'approve');
    }
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'approved');
    assert.equal(events[0]?.type, 'approval-resolved');
  });

  it('keeps a committed reject when the audit sink throws', () => {
    const manager = new ApprovalManager({
      now: () => 1_000,
      generatePreparedActionId: () => 'prep-1',
      generateApprovalId: () => 'appr-1',
    });
    const action = manager.prepare(prepareInput());
    const controller = new ApprovalController({
      manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager,
        audit: {
          append() {
            throw new Error('audit sink unavailable');
          },
          getEvents() {
            return [];
          },
          clear() {},
        },
      }),
      emit: () => undefined,
    });

    const result = controller.decide({ approvalId: action.approvalId, decision: 'reject' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decision, 'reject');
    }
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'rejected');
    assert.equal(manager.getSnapshot(action.approvalId)?.executionGrant, undefined);
  });

  it('keeps a committed decision when renderer emission throws', () => {
    const harness = createHarness();
    const action = harness.manager.prepare(prepareInput());
    const controller = new ApprovalController({
      manager: harness.manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager: harness.manager,
        audit: harness.audit,
        now: () => harness.now,
      }),
      emit: () => {
        throw new Error('renderer emit failed');
      },
    });

    const result = controller.decide({ approvalId: action.approvalId, decision: 'approve' });
    assert.equal(result.ok, true);
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'approved');
    assert.equal(harness.audit.getEvents()[0]?.eventType, 'approved');
  });
});
