import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ApprovalManager } from './approval-manager';
import { ApprovalError, type ApprovalErrorCode } from '../shared/approval-errors';
import {
  PREPARED_ACTION_TTL_MS,
  type PreparePreparedActionInput,
  type PreparedAction,
  type PreparedActionRecordSnapshot,
} from '../shared/approval-types';

interface Harness {
  manager: ApprovalManager;
  now: number;
  setNow(value: number): void;
}

function createHarness(startNow = 1_000): Harness {
  const ids = { prepared: 0, approval: 0, execution: 0 };
  const harness: Harness = {
    now: startNow,
    setNow(value: number) {
      harness.now = value;
    },
    manager: new ApprovalManager({
      now: () => harness.now,
      generatePreparedActionId: () => `prep-${++ids.prepared}`,
      generateApprovalId: () => `appr-${++ids.approval}`,
      generateExecutionId: () => `exec-${++ids.execution}`,
    }),
  };
  return harness;
}

function input(overrides: Partial<PreparePreparedActionInput> = {}): PreparePreparedActionInput {
  return {
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
    targetId: 'target-1',
    category: 'submit',
    summary: { title: 'Submit form', origin: 'https://example.test' },
    ...overrides,
  };
}

function assertApprovalError(fn: () => unknown, code: ApprovalErrorCode): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ApprovalError);
    assert.equal(error.code, code);
    return true;
  });
}

function requireSnapshot(manager: ApprovalManager, approvalId: string): PreparedActionRecordSnapshot {
  const snapshot = manager.getSnapshot(approvalId);
  assert.ok(snapshot);
  return snapshot;
}

function createSequencedClockManager(): {
  manager: ApprovalManager;
  queueNow: (...values: number[]) => void;
  readCount: () => number;
} {
  const ids = { prepared: 0, approval: 0, execution: 0 };
  const sequence: number[] = [];
  let index = 0;
  return {
    queueNow: (...values: number[]) => {
      sequence.push(...values);
    },
    readCount: () => index,
    manager: new ApprovalManager({
      now: () => {
        if (index >= sequence.length) {
          throw new Error(`unexpected extra now() read at index ${index}`);
        }
        const value = sequence[index];
        index += 1;
        return value;
      },
      generatePreparedActionId: () => `prep-${++ids.prepared}`,
      generateApprovalId: () => `appr-${++ids.approval}`,
      generateExecutionId: () => `exec-${++ids.execution}`,
    }),
  };
}

function approveAndClaim(harness: Harness, prepared = input()): {
  action: PreparedAction;
  grant: ReturnType<ApprovalManager['claimExecuteGrant']>;
} {
  const action = harness.manager.prepare(prepared);
  harness.manager.decide(action.approvalId, 'approve');
  const grant = harness.manager.claimExecuteGrant(action.approvalId);
  return { action, grant };
}

describe('ApprovalManager prepare', () => {
  it('creates a pending action with injected clock, TTL, unique ids, and false facts', () => {
    const harness = createHarness(5_000);
    const first = harness.manager.prepare(input());
    const second = harness.manager.prepare(input({ tabId: 'tab-2' }));

    assert.equal(first.state, 'pending');
    assert.equal(first.kind, 'click');
    assert.equal(first.createdAt, 5_000);
    assert.equal(first.expiresAt, 5_000 + PREPARED_ACTION_TTL_MS);
    assert.equal(PREPARED_ACTION_TTL_MS, 120_000);
    assert.equal(first.preparedActionId, 'prep-1');
    assert.equal(first.approvalId, 'appr-1');
    assert.notEqual(second.preparedActionId, first.preparedActionId);
    assert.notEqual(second.approvalId, first.approvalId);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.summary), true);

    const facts = requireSnapshot(harness.manager, first.approvalId).facts;
    assert.deepEqual(facts, {
      grantIssued: false,
      grantClaimed: false,
      adapterPrimitiveInvoked: false,
      postObservationSucceeded: false,
    });
    assert.equal(requireSnapshot(harness.manager, first.approvalId).executionGrant, undefined);
    assert.equal(requireSnapshot(harness.manager, first.approvalId).decision, undefined);
    assert.equal(harness.manager.getByPreparedActionId(first.preparedActionId)?.approvalId, first.approvalId);
    assert.equal(harness.manager.getPendingForTab('tab-1')?.preparedActionId, first.preparedActionId);
  });
});

describe('ApprovalManager decide', () => {
  it('approves pending without issuing an ExecuteGrant', () => {
    const { manager } = createHarness();
    const action = manager.prepare(input());
    const decision = manager.decide(action.approvalId, 'approve');

    assert.equal(decision.decision, 'approve');
    assert.equal(decision.approvalId, action.approvalId);
    assert.equal(decision.preparedActionId, action.preparedActionId);
    assert.equal(Object.isFrozen(decision), true);
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'approved');

    const snapshot = requireSnapshot(manager, action.approvalId);
    assert.deepEqual(snapshot.facts, {
      grantIssued: true,
      grantClaimed: false,
      adapterPrimitiveInvoked: false,
      postObservationSucceeded: false,
    });
    assert.equal(snapshot.executionGrant, undefined);
  });

  it('rejects pending and blocks later approve or claim', () => {
    const { manager } = createHarness();
    const action = manager.prepare(input());
    const decision = manager.decide(action.approvalId, 'reject');

    assert.equal(decision.decision, 'reject');
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'rejected');
    assertApprovalError(() => manager.decide(action.approvalId, 'approve'), 'APPROVAL_ALREADY_DECIDED');
    assertApprovalError(() => manager.claimExecuteGrant(action.approvalId), 'INVALID_APPROVAL_TRANSITION');
    assert.equal(requireSnapshot(manager, action.approvalId).facts.grantIssued, false);
    assert.equal(requireSnapshot(manager, action.approvalId).executionGrant, undefined);
  });

  it('rejects a second decide after approve', () => {
    const { manager } = createHarness();
    const action = manager.prepare(input());
    const first = manager.decide(action.approvalId, 'approve');
    assertApprovalError(() => manager.decide(action.approvalId, 'approve'), 'APPROVAL_ALREADY_DECIDED');
    assertApprovalError(() => manager.decide(action.approvalId, 'reject'), 'APPROVAL_ALREADY_DECIDED');
    assert.equal(requireSnapshot(manager, action.approvalId).decision?.decidedAt, first.decidedAt);
    assert.equal(requireSnapshot(manager, action.approvalId).decision?.decision, 'approve');
  });

  it('lets exactly one of competing approve/reject win', async () => {
    const { manager } = createHarness();
    const action = manager.prepare(input());
    const results = await Promise.allSettled([
      Promise.resolve().then(() => manager.decide(action.approvalId, 'approve')),
      Promise.resolve().then(() => manager.decide(action.approvalId, 'reject')),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const state = manager.getByApprovalId(action.approvalId)?.state;
    assert.ok(state === 'approved' || state === 'rejected');
    if (state === 'rejected') {
      assertApprovalError(() => manager.claimExecuteGrant(action.approvalId), 'INVALID_APPROVAL_TRANSITION');
    } else {
      const grant = manager.claimExecuteGrant(action.approvalId);
      assert.equal(grant.authority, 'EXECUTE');
      assertApprovalError(() => manager.claimExecuteGrant(action.approvalId), 'EXECUTE_GRANT_ALREADY_CLAIMED');
    }
  });

  it('uses one clock sample for TTL and decidedAt', () => {
    const clock = createSequencedClockManager();
    clock.queueNow(1_000);
    const action = clock.manager.prepare(input());
    assert.equal(action.expiresAt, 121_000);

    const readsBeforeDecide = clock.readCount();
    clock.queueNow(120_999);
    const decision = clock.manager.decide(action.approvalId, 'approve');

    assert.equal(clock.readCount() - readsBeforeDecide, 1);
    assert.equal(decision.decidedAt, 120_999);
    assert.equal(clock.manager.getByApprovalId(action.approvalId)?.state, 'approved');
    assert.equal(requireSnapshot(clock.manager, action.approvalId).decision?.decidedAt, 120_999);
  });

  it('expires from the same single timestamp when decide starts at expiresAt', () => {
    const clock = createSequencedClockManager();
    clock.queueNow(1_000);
    const action = clock.manager.prepare(input());

    const readsBeforeDecide = clock.readCount();
    clock.queueNow(121_000, 120_999);
    assertApprovalError(() => clock.manager.decide(action.approvalId, 'approve'), 'APPROVAL_EXPIRED');
    assert.equal(clock.readCount() - readsBeforeDecide, 1);
    assert.equal(clock.manager.getByApprovalId(action.approvalId)?.state, 'expired');
    assert.equal(requireSnapshot(clock.manager, action.approvalId).decision, undefined);
  });
});

describe('ApprovalManager expiry', () => {
  it('allows approve at expiresAt - 1 and expires at expiresAt', () => {
    const harness = createHarness(1_000);
    const action = harness.manager.prepare(input());
    assert.equal(action.expiresAt, 121_000);

    harness.setNow(120_999);
    const decision = harness.manager.decide(action.approvalId, 'approve');
    assert.equal(decision.decision, 'approve');
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'approved');

    const expiredPending = harness.manager.prepare(input({ tabId: 'tab-exp' }));
    harness.setNow(expiredPending.expiresAt);
    assertApprovalError(() => harness.manager.decide(expiredPending.approvalId, 'approve'), 'APPROVAL_EXPIRED');
    assert.equal(harness.manager.getByApprovalId(expiredPending.approvalId)?.state, 'expired');
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(expiredPending.approvalId),
      'APPROVAL_EXPIRED',
    );
  });

  it('expires an approved unclaimed action at claim time', () => {
    const harness = createHarness(1_000);
    const action = harness.manager.prepare(input());
    harness.manager.decide(action.approvalId, 'approve');
    harness.setNow(action.expiresAt);

    assertApprovalError(() => harness.manager.claimExecuteGrant(action.approvalId), 'APPROVAL_EXPIRED');
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'expired');
    assert.equal(requireSnapshot(harness.manager, action.approvalId).executionGrant, undefined);
    assert.equal(requireSnapshot(harness.manager, action.approvalId).facts.grantClaimed, false);
  });

  it('bulk-expires pending and approved actions across tabs and skips executing', () => {
    const harness = createHarness(1_000);
    const pendingA = harness.manager.prepare(input({ tabId: 'tab-a' }));
    const pendingB = harness.manager.prepare(input({ tabId: 'tab-b' }));
    harness.manager.decide(pendingB.approvalId, 'approve');
    const claimed = approveAndClaim(harness, input({ tabId: 'tab-c', targetId: 'target-c' }));

    harness.setNow(pendingA.expiresAt + 50);
    const expired = harness.manager.expire();
    const expiredIds = expired.map((snapshot) => snapshot.action.approvalId).sort();
    assert.deepEqual(expiredIds, [pendingA.approvalId, pendingB.approvalId].sort());
    assert.equal(harness.manager.getByApprovalId(pendingA.approvalId)?.state, 'expired');
    assert.equal(harness.manager.getByApprovalId(pendingB.approvalId)?.state, 'expired');
    assert.equal(harness.manager.getByApprovalId(claimed.action.approvalId)?.state, 'executing');
  });
});

describe('ApprovalManager claimExecuteGrant', () => {
  it('claims a single frozen ExecuteGrant and copies exact identity', () => {
    const harness = createHarness();
    const prepared = input({
      tabId: 'tab-9',
      observationId: 'obs-9',
      documentRevision: 'rev-9',
      targetId: 'target-9',
    });
    const { action, grant } = approveAndClaim(harness, prepared);
    const snapshot = requireSnapshot(harness.manager, action.approvalId);

    assert.equal(snapshot.action.state, 'executing');
    assert.deepEqual(snapshot.facts, {
      grantIssued: true,
      grantClaimed: true,
      adapterPrimitiveInvoked: false,
      postObservationSucceeded: false,
    });
    assert.equal(grant.executionId, 'exec-1');
    assert.equal(grant.authority, 'EXECUTE');
    assert.equal(grant.kind, 'click');
    assert.equal(Object.isFrozen(grant), true);
    assert.equal(grant.preparedActionId, action.preparedActionId);
    assert.equal(grant.approvalId, action.approvalId);
    assert.equal(snapshot.decision?.preparedActionId, action.preparedActionId);
    assert.equal(snapshot.decision?.approvalId, action.approvalId);
    assert.equal(grant.tabId, prepared.tabId);
    assert.equal(grant.observationId, prepared.observationId);
    assert.equal(grant.documentRevision, prepared.documentRevision);
    assert.equal(grant.targetId, prepared.targetId);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );
  });

  it('uses one clock sample for TTL and issuedAt', () => {
    const clock = createSequencedClockManager();
    clock.queueNow(1_000, 1_000);
    const action = clock.manager.prepare(input());
    clock.manager.decide(action.approvalId, 'approve');

    const readsBeforeClaim = clock.readCount();
    clock.queueNow(120_999);
    const grant = clock.manager.claimExecuteGrant(action.approvalId);

    assert.equal(clock.readCount() - readsBeforeClaim, 1);
    assert.equal(grant.issuedAt, 120_999);
    assert.equal(clock.manager.getByApprovalId(action.approvalId)?.state, 'executing');
  });

  it('expires an approved action from the same single claim timestamp', () => {
    const clock = createSequencedClockManager();
    clock.queueNow(1_000, 1_000);
    const action = clock.manager.prepare(input());
    clock.manager.decide(action.approvalId, 'approve');

    const readsBeforeClaim = clock.readCount();
    clock.queueNow(121_000, 120_999);
    assertApprovalError(() => clock.manager.claimExecuteGrant(action.approvalId), 'APPROVAL_EXPIRED');
    assert.equal(clock.readCount() - readsBeforeClaim, 1);
    assert.equal(clock.manager.getByApprovalId(action.approvalId)?.state, 'expired');
    assert.equal(requireSnapshot(clock.manager, action.approvalId).executionGrant, undefined);
    assert.equal(requireSnapshot(clock.manager, action.approvalId).facts.grantClaimed, false);
  });
});

describe('ApprovalManager execution-stage outcomes', () => {
  it('marks claimed execution stale before dispatch without reclaim', () => {
    const harness = createHarness();
    const { action, grant } = approveAndClaim(harness);
    harness.manager.markStaleBeforeDispatch(grant.executionId);

    const snapshot = requireSnapshot(harness.manager, action.approvalId);
    assert.equal(snapshot.action.state, 'stale');
    assert.equal(snapshot.facts.adapterPrimitiveInvoked, false);
    assert.equal(snapshot.facts.grantClaimed, true);
    assert.equal(snapshot.executionGrant?.executionId, grant.executionId);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );
  });

  it('marks claimed execution failed before dispatch without reclaim', () => {
    const harness = createHarness();
    const { action, grant } = approveAndClaim(harness);
    harness.manager.markFailedBeforeDispatch(grant.executionId);

    const snapshot = requireSnapshot(harness.manager, action.approvalId);
    assert.equal(snapshot.action.state, 'failed');
    assert.equal(snapshot.facts.adapterPrimitiveInvoked, false);
    assert.equal(snapshot.facts.grantClaimed, true);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );
  });

  it('records the adapter-dispatch boundary and forbids stale/failed/expire/invalidate-to-stale', () => {
    const harness = createHarness();
    const { action, grant } = approveAndClaim(harness);
    harness.manager.markAdapterPrimitiveInvoked(grant.executionId);

    const snapshot = requireSnapshot(harness.manager, action.approvalId);
    assert.equal(snapshot.action.state, 'executing');
    assert.equal(snapshot.facts.grantClaimed, true);
    assert.equal(snapshot.facts.adapterPrimitiveInvoked, true);
    assertApprovalError(
      () => harness.manager.markAdapterPrimitiveInvoked(grant.executionId),
      'INVALID_APPROVAL_TRANSITION',
    );
    assertApprovalError(
      () => harness.manager.markStaleBeforeDispatch(grant.executionId),
      'INVALID_APPROVAL_TRANSITION',
    );
    assertApprovalError(
      () => harness.manager.markFailedBeforeDispatch(grant.executionId),
      'INVALID_APPROVAL_TRANSITION',
    );
    assertApprovalError(() => harness.manager.markStale(action.approvalId), 'INVALID_APPROVAL_TRANSITION');
    assertApprovalError(() => harness.manager.decide(action.approvalId, 'reject'), 'APPROVAL_ALREADY_DECIDED');

    harness.setNow(action.expiresAt + 1);
    const expired = harness.manager.expire();
    assert.equal(expired.length, 0);
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'executing');

    const invalidated = harness.manager.invalidateTab(action.tabId);
    assert.equal(invalidated.length, 0);
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'executing');
  });

  it('marks executed after dispatch with successful observation', () => {
    const harness = createHarness();
    const { action, grant } = approveAndClaim(harness);
    harness.manager.markAdapterPrimitiveInvoked(grant.executionId);
    harness.manager.markExecuted(grant.executionId);

    const snapshot = requireSnapshot(harness.manager, action.approvalId);
    assert.equal(snapshot.action.state, 'executed');
    assert.equal(snapshot.facts.postObservationSucceeded, true);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );
    assertApprovalError(() => harness.manager.markExecuted(grant.executionId), 'INVALID_APPROVAL_TRANSITION');
    assertApprovalError(
      () => harness.manager.markExecutionStateUnknown(grant.executionId),
      'INVALID_APPROVAL_TRANSITION',
    );
  });

  it('marks execution-attempted-state-unknown after dispatch without retry', () => {
    const harness = createHarness();
    const { action, grant } = approveAndClaim(harness);
    harness.manager.markAdapterPrimitiveInvoked(grant.executionId);
    harness.manager.markExecutionStateUnknown(grant.executionId);

    const snapshot = requireSnapshot(harness.manager, action.approvalId);
    assert.equal(snapshot.action.state, 'execution-attempted-state-unknown');
    assert.equal(snapshot.facts.postObservationSucceeded, false);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );
    assertApprovalError(
      () => harness.manager.markExecutionStateUnknown(grant.executionId),
      'INVALID_APPROVAL_TRANSITION',
    );
  });
});

describe('ApprovalManager pre-claim stale and replacement', () => {
  it('stales pending and approved actions before claim', () => {
    const { manager } = createHarness();
    const pending = manager.prepare(input({ tabId: 'tab-pending' }));
    manager.markStale(pending.approvalId);
    assert.equal(manager.getByApprovalId(pending.approvalId)?.state, 'stale');
    assertApprovalError(() => manager.claimExecuteGrant(pending.approvalId), 'APPROVAL_STALE');

    const approved = manager.prepare(input({ tabId: 'tab-approved' }));
    manager.decide(approved.approvalId, 'approve');
    manager.markStale(approved.approvalId);
    assert.equal(manager.getByApprovalId(approved.approvalId)?.state, 'stale');
    assert.equal(requireSnapshot(manager, approved.approvalId).facts.grantClaimed, false);
    assert.equal(requireSnapshot(manager, approved.approvalId).executionGrant, undefined);
    assertApprovalError(() => manager.claimExecuteGrant(approved.approvalId), 'APPROVAL_STALE');
  });

  it('stales a prior pending or approved action on the same tab', () => {
    const { manager } = createHarness();
    const firstPending = manager.prepare(input({ tabId: 'tab-1', targetId: 'a' }));
    const secondPending = manager.prepare(input({ tabId: 'tab-1', targetId: 'b' }));
    assert.equal(manager.getByApprovalId(firstPending.approvalId)?.state, 'stale');
    assert.equal(secondPending.state, 'pending');
    assert.equal(manager.getPendingForTab('tab-1')?.approvalId, secondPending.approvalId);

    manager.decide(secondPending.approvalId, 'approve');
    const replacement = manager.prepare(input({ tabId: 'tab-1', targetId: 'c' }));
    assert.equal(manager.getByApprovalId(secondPending.approvalId)?.state, 'stale');
    assert.equal(replacement.state, 'pending');
    assertApprovalError(
      () => manager.claimExecuteGrant(secondPending.approvalId),
      'APPROVAL_STALE',
    );

    const otherTab = manager.prepare(input({ tabId: 'tab-2', targetId: 'other' }));
    manager.prepare(input({ tabId: 'tab-1', targetId: 'd' }));
    assert.equal(manager.getByApprovalId(otherTab.approvalId)?.state, 'pending');
  });

  it('does not rewrite executing or terminal records when preparing a new pending action', () => {
    const harness = createHarness();
    const { action, grant } = approveAndClaim(harness, input({ tabId: 'tab-1', targetId: 'live' }));
    const next = harness.manager.prepare(input({ tabId: 'tab-1', targetId: 'next' }));
    assert.equal(next.state, 'pending');
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'executing');

    harness.manager.markAdapterPrimitiveInvoked(grant.executionId);
    harness.manager.markExecuted(grant.executionId);
    harness.manager.prepare(input({ tabId: 'tab-1', targetId: 'after-exec' }));
    assert.equal(harness.manager.getByApprovalId(action.approvalId)?.state, 'executed');
  });
});

describe('ApprovalManager invalidation', () => {
  it('invalidates only the matching tab and observation', () => {
    const { manager } = createHarness();
    const match = manager.prepare(input({ tabId: 'tab-1', observationId: 'obs-old' }));
    const otherObs = manager.prepare(input({ tabId: 'tab-2', observationId: 'obs-new' }));
    const otherTabSameObs = manager.prepare(input({ tabId: 'tab-3', observationId: 'obs-old' }));

    manager.invalidateObservation('tab-1', 'obs-old');
    assert.equal(manager.getByApprovalId(match.approvalId)?.state, 'stale');
    assert.equal(manager.getByApprovalId(otherObs.approvalId)?.state, 'pending');
    assert.equal(manager.getByApprovalId(otherTabSameObs.approvalId)?.state, 'pending');
  });

  it('stales pending, approved, and pre-dispatch executing on tab invalidate, but not after dispatch', () => {
    const harness = createHarness();
    const pending = harness.manager.prepare(input({ tabId: 'tab-pending' }));
    const approved = harness.manager.prepare(input({ tabId: 'tab-approved' }));
    harness.manager.decide(approved.approvalId, 'approve');
    const preDispatch = approveAndClaim(harness, input({ tabId: 'tab-pre' }));
    const postDispatch = approveAndClaim(harness, input({ tabId: 'tab-post' }));
    harness.manager.markAdapterPrimitiveInvoked(postDispatch.grant.executionId);

    harness.manager.invalidateTab('tab-pending');
    harness.manager.invalidateTab('tab-approved');
    harness.manager.invalidateTab('tab-pre');
    harness.manager.invalidateTab('tab-post');

    assert.equal(harness.manager.getByApprovalId(pending.approvalId)?.state, 'stale');
    assert.equal(harness.manager.getByApprovalId(approved.approvalId)?.state, 'stale');
    assert.equal(harness.manager.getByApprovalId(preDispatch.action.approvalId)?.state, 'stale');
    assert.equal(harness.manager.getByApprovalId(postDispatch.action.approvalId)?.state, 'executing');
  });
});

describe('ApprovalManager invalid transitions', () => {
  it('rejects skipped and terminal-reversing transitions', () => {
    const harness = createHarness();
    const pending = harness.manager.prepare(input());
    assertApprovalError(() => harness.manager.claimExecuteGrant(pending.approvalId), 'INVALID_APPROVAL_TRANSITION');
    assertApprovalError(() => harness.manager.markExecuted('missing'), 'EXECUTION_NOT_FOUND');
    assertApprovalError(() => harness.manager.decide('missing', 'approve'), 'APPROVAL_NOT_FOUND');

    const approved = harness.manager.prepare(input({ tabId: 'tab-approved' }));
    harness.manager.decide(approved.approvalId, 'approve');
    assertApprovalError(() => harness.manager.markExecuted('exec-none'), 'EXECUTION_NOT_FOUND');
    assertApprovalError(
      () => harness.manager.markExecutionStateUnknown('exec-none'),
      'EXECUTION_NOT_FOUND',
    );

    const { grant } = approveAndClaim(harness, input({ tabId: 'tab-exec' }));
    assertApprovalError(() => harness.manager.markExecuted(grant.executionId), 'INVALID_APPROVAL_TRANSITION');
    assertApprovalError(
      () => harness.manager.markExecutionStateUnknown(grant.executionId),
      'INVALID_APPROVAL_TRANSITION',
    );

    harness.manager.markAdapterPrimitiveInvoked(grant.executionId);
    assertApprovalError(
      () => harness.manager.markStaleBeforeDispatch(grant.executionId),
      'INVALID_APPROVAL_TRANSITION',
    );
    assertApprovalError(
      () => harness.manager.markFailedBeforeDispatch(grant.executionId),
      'INVALID_APPROVAL_TRANSITION',
    );

    const rejected = harness.manager.prepare(input({ tabId: 'tab-rej' }));
    harness.manager.decide(rejected.approvalId, 'reject');
    assertApprovalError(() => harness.manager.decide(rejected.approvalId, 'approve'), 'APPROVAL_ALREADY_DECIDED');

    const expired = harness.manager.prepare(input({ tabId: 'tab-exp' }));
    harness.setNow(expired.expiresAt);
    assertApprovalError(() => harness.manager.decide(expired.approvalId, 'approve'), 'APPROVAL_EXPIRED');

    const stale = harness.manager.prepare(input({ tabId: 'tab-stale' }));
    harness.manager.markStale(stale.approvalId);
    assertApprovalError(() => harness.manager.decide(stale.approvalId, 'approve'), 'APPROVAL_STALE');

    const failed = approveAndClaim(harness, input({ tabId: 'tab-fail' }));
    harness.manager.markFailedBeforeDispatch(failed.grant.executionId);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(failed.action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );

    const executed = approveAndClaim(harness, input({ tabId: 'tab-done' }));
    harness.manager.markAdapterPrimitiveInvoked(executed.grant.executionId);
    harness.manager.markExecuted(executed.grant.executionId);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(executed.action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );

    const unknown = approveAndClaim(harness, input({ tabId: 'tab-unk' }));
    harness.manager.markAdapterPrimitiveInvoked(unknown.grant.executionId);
    harness.manager.markExecutionStateUnknown(unknown.grant.executionId);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(unknown.action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );
  });
});

describe('ApprovalManager immutability and privacy', () => {
  it('does not let snapshot mutation change manager-owned authority', () => {
    const { manager } = createHarness();
    const action = manager.prepare(input({ summary: { title: 'Submit form' } }));
    const snapshot = requireSnapshot(manager, action.approvalId);

    try {
      (snapshot.action as { state: string }).state = 'executed';
    } catch {
      // frozen snapshots throw in strict mode
    }
    try {
      (snapshot.action.summary as { title: string }).title = 'tampered';
    } catch {
      // frozen snapshots throw in strict mode
    }

    const reread = manager.getByApprovalId(action.approvalId);
    assert.equal(reread?.state, 'pending');
    assert.equal(reread?.summary.title, 'Submit form');
  });

  it('does not serialize browser handles or model internals on public objects', () => {
    const harness = createHarness();
    const { action, grant } = approveAndClaim(harness, input({
      summary: { title: 'Buy now', description: 'Confirm purchase', origin: 'https://shop.test' },
    }));
    const decision = requireSnapshot(harness.manager, action.approvalId).decision;
    const snapshot = requireSnapshot(harness.manager, action.approvalId);
    const serialized = [
      JSON.stringify(action),
      JSON.stringify(decision),
      JSON.stringify(grant),
      JSON.stringify(snapshot),
    ].join('\n');

    for (const needle of [
      'backendNodeId',
      'axNodeId',
      'frameId',
      'WebContents',
      'CDP',
      'providerModel',
      'model reasoning',
    ]) {
      assert.equal(serialized.includes(needle), false, `leaked ${needle}`);
    }

    assert.equal(serialized.includes(grant.targetId), true);
    assert.equal(serialized.includes(grant.tabId), true);
    assert.equal(serialized.includes(grant.observationId), true);
    assert.equal(serialized.includes(grant.documentRevision), true);
  });

  it('does not import browser, Electron, IPC, or V3 execution surfaces', () => {
    const files = [
      path.join(__dirname, 'approval-manager.ts'),
      path.join(__dirname, '../shared/approval-types.ts'),
      path.join(__dirname, '../shared/approval-errors.ts'),
    ];
    const forbidden = [
      'BrowserAdapter',
      'ElectronBrowserAdapter',
      'WebContents',
      'InteractionCdpClient',
      'TargetRegistry',
      'ipcMain',
      'React',
      'AiSdkGatewayRuntime',
      '.click(',
      'dispatchMouse',
      'observePage(',
      'executeJavaScript',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        assert.equal(source.includes(needle), false, `${file} contains ${needle}`);
      }
    }
  });
});

describe('ApprovalManager authority ID uniqueness', () => {
  function createCollidingManager(initial: {
    prepared: string;
    approval: string;
    execution: string;
  }) {
    const next = { ...initial, now: 1_000 };
    const manager = new ApprovalManager({
      now: () => next.now,
      generatePreparedActionId: () => next.prepared,
      generateApprovalId: () => next.approval,
      generateExecutionId: () => next.execution,
    });
    return { manager, next };
  }

  it('does not overwrite or stale existing authority on preparedActionId collision', () => {
    const { manager, next } = createCollidingManager({
      prepared: 'prepared-existing',
      approval: 'approval-existing',
      execution: 'exec-1',
    });
    const existing = manager.prepare(input({ tabId: 'tab-1', targetId: 'target-a' }));

    next.prepared = 'prepared-existing';
    next.approval = 'approval-new';
    assertApprovalError(() => manager.prepare(input({ tabId: 'tab-1', targetId: 'target-b' })), 'AUTHORITY_ID_COLLISION');

    assert.equal(manager.getByApprovalId(existing.approvalId)?.state, 'pending');
    assert.equal(manager.getPendingForTab('tab-1')?.approvalId, existing.approvalId);
    assert.equal(manager.getByPreparedActionId('prepared-existing')?.targetId, 'target-a');
    assert.equal(manager.getByApprovalId('approval-new'), undefined);
  });

  it('does not overwrite or stale existing authority on approvalId collision', () => {
    const { manager, next } = createCollidingManager({
      prepared: 'prepared-existing',
      approval: 'approval-existing',
      execution: 'exec-1',
    });
    const existing = manager.prepare(input({ tabId: 'tab-1', targetId: 'target-a' }));

    next.prepared = 'prepared-new';
    next.approval = 'approval-existing';
    assertApprovalError(() => manager.prepare(input({ tabId: 'tab-1', targetId: 'target-b' })), 'AUTHORITY_ID_COLLISION');

    assert.equal(manager.getByApprovalId(existing.approvalId)?.state, 'pending');
    assert.equal(manager.getPendingForTab('tab-1')?.approvalId, existing.approvalId);
    assert.equal(manager.getByPreparedActionId('prepared-existing')?.approvalId, existing.approvalId);
    assert.equal(manager.getByPreparedActionId('prepared-new'), undefined);
  });

  it('does not stale existing same-tab approval when a generated ID is empty or whitespace', () => {
    const next = { prepared: 'prep-1', approval: 'appr-1' };
    const manager = new ApprovalManager({
      now: () => 1_000,
      generatePreparedActionId: () => next.prepared,
      generateApprovalId: () => next.approval,
    });
    const existing = manager.prepare(input({ tabId: 'tab-1' }));

    next.prepared = '';
    next.approval = 'appr-2';
    assertApprovalError(() => manager.prepare(input({ tabId: 'tab-1' })), 'INVALID_APPROVAL_TRANSITION');
    assert.equal(manager.getPendingForTab('tab-1')?.approvalId, existing.approvalId);

    next.prepared = '   ';
    assertApprovalError(() => manager.prepare(input({ tabId: 'tab-1' })), 'INVALID_APPROVAL_TRANSITION');
    assert.equal(manager.getByApprovalId(existing.approvalId)?.state, 'pending');
    assert.equal(manager.getPendingForTab('tab-1')?.preparedActionId, existing.preparedActionId);
  });

  it('does not stale existing same-tab approval when a prepare generator throws', () => {
    const next = { prepared: 'prep-1', approval: 'appr-1', fail: false };
    const manager = new ApprovalManager({
      now: () => 1_000,
      generatePreparedActionId: () => {
        if (next.fail) {
          throw new Error('prepared-id-failed');
        }
        return next.prepared;
      },
      generateApprovalId: () => next.approval,
    });
    const existing = manager.prepare(input({ tabId: 'tab-1' }));
    next.fail = true;
    next.approval = 'appr-2';

    assert.throws(() => manager.prepare(input({ tabId: 'tab-1' })), /prepared-id-failed/);
    assert.equal(manager.getByApprovalId(existing.approvalId)?.state, 'pending');
    assert.equal(manager.getPendingForTab('tab-1')?.approvalId, existing.approvalId);
  });

  it('does not consume an approval when executionId collides, then allows a unique retry', () => {
    const next = {
      prepared: 'prep-a',
      approval: 'appr-a',
      execution: 'exec-existing',
    };
    const manager = new ApprovalManager({
      now: () => 1_000,
      generatePreparedActionId: () => next.prepared,
      generateApprovalId: () => next.approval,
      generateExecutionId: () => next.execution,
    });

    const first = manager.prepare(input({ tabId: 'tab-a', targetId: 'target-a' }));
    manager.decide(first.approvalId, 'approve');
    const firstGrant = manager.claimExecuteGrant(first.approvalId);
    assert.equal(firstGrant.executionId, 'exec-existing');

    next.prepared = 'prep-b';
    next.approval = 'appr-b';
    const second = manager.prepare(input({ tabId: 'tab-b', targetId: 'target-b' }));
    manager.decide(second.approvalId, 'approve');

    assertApprovalError(() => manager.claimExecuteGrant(second.approvalId), 'AUTHORITY_ID_COLLISION');
    const failedClaim = requireSnapshot(manager, second.approvalId);
    assert.equal(failedClaim.action.state, 'approved');
    assert.equal(failedClaim.facts.grantIssued, true);
    assert.equal(failedClaim.facts.grantClaimed, false);
    assert.equal(failedClaim.facts.adapterPrimitiveInvoked, false);
    assert.equal(failedClaim.executionGrant, undefined);

    manager.markAdapterPrimitiveInvoked(firstGrant.executionId);
    assert.equal(requireSnapshot(manager, first.approvalId).facts.adapterPrimitiveInvoked, true);
    assert.equal(requireSnapshot(manager, first.approvalId).action.state, 'executing');

    next.execution = 'exec-fresh';
    const retryGrant = manager.claimExecuteGrant(second.approvalId);
    assert.equal(retryGrant.executionId, 'exec-fresh');
    assert.equal(manager.getByApprovalId(second.approvalId)?.state, 'executing');
    assertApprovalError(() => manager.claimExecuteGrant(second.approvalId), 'EXECUTE_GRANT_ALREADY_CLAIMED');
  });

  it('does not consume an approval when the execution generator throws', () => {
    const next = { prepared: 'prep-1', approval: 'appr-1', failExecution: false };
    const manager = new ApprovalManager({
      now: () => 1_000,
      generatePreparedActionId: () => next.prepared,
      generateApprovalId: () => next.approval,
      generateExecutionId: () => {
        if (next.failExecution) {
          throw new Error('execution-id-failed');
        }
        return 'exec-1';
      },
    });
    const action = manager.prepare(input());
    manager.decide(action.approvalId, 'approve');
    next.failExecution = true;

    assert.throws(() => manager.claimExecuteGrant(action.approvalId), /execution-id-failed/);
    const snapshot = requireSnapshot(manager, action.approvalId);
    assert.equal(snapshot.action.state, 'approved');
    assert.equal(snapshot.facts.grantIssued, true);
    assert.equal(snapshot.facts.grantClaimed, false);
    assert.equal(snapshot.executionGrant, undefined);

    next.failExecution = false;
    const grant = manager.claimExecuteGrant(action.approvalId);
    assert.equal(grant.executionId, 'exec-1');
  });

  it('still treats a successful claim as permanently single-use after later stale', () => {
    const harness = createHarness();
    const { action, grant } = approveAndClaim(harness);
    harness.manager.markStaleBeforeDispatch(grant.executionId);
    assertApprovalError(
      () => harness.manager.claimExecuteGrant(action.approvalId),
      'EXECUTE_GRANT_ALREADY_CLAIMED',
    );
  });
});

