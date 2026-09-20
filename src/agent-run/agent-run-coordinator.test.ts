import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { fingerprintAction } from './action-fingerprint';
import { InMemoryAgentRunAuditSink, type AgentRunAuditSink } from './agent-run-audit';
import { AgentRunCoordinator } from './agent-run-coordinator';
import { AgentRunError, type AgentRunErrorCode } from './agent-run-errors';
import {
  MAX_AGENT_LOOP_ACTION_ATTEMPTS,
  MAX_AGENT_LOOP_APPROVALS,
  MAX_AGENT_LOOP_MODEL_STEPS,
  toAgentRunRef,
  type AgentRunMutationResult,
  type AgentRunRef,
  type AgentRunSnapshot,
} from './agent-run-types';

interface Harness {
  coordinator: AgentRunCoordinator;
  sink: InMemoryAgentRunAuditSink;
  now: number;
  queuedRunId: string | undefined;
  setNow(value: number): void;
  setNextRunId(value: string): void;
}

function createHarness(startNow = 1_000): Harness {
  let runSerial = 0;
  const harness: Harness = {
    now: startNow,
    queuedRunId: undefined,
    sink: new InMemoryAgentRunAuditSink(),
    coordinator: undefined as unknown as AgentRunCoordinator,
    setNow(value: number) {
      harness.now = value;
    },
    setNextRunId(value: string) {
      harness.queuedRunId = value;
    },
  };
  harness.coordinator = new AgentRunCoordinator({
    now: () => harness.now,
    generateRunId: () => {
      if (harness.queuedRunId !== undefined) {
        const id = harness.queuedRunId;
        harness.queuedRunId = undefined;
        return id;
      }
      runSerial += 1;
      return `run-${runSerial}`;
    },
    auditSink: harness.sink,
  });
  return harness;
}

function start(harness: Harness, tabId = 'tab-1', instruction = 'do the task'): AgentRunSnapshot {
  return harness.coordinator.startRun(tabId, instruction);
}

function refOf(snapshot: AgentRunSnapshot): AgentRunRef {
  return toAgentRunRef(snapshot);
}

function requireApplied(result: AgentRunMutationResult): AgentRunSnapshot {
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') {
    throw new Error('expected applied mutation');
  }
  return result.snapshot;
}

function assertIgnored(result: AgentRunMutationResult): void {
  assert.deepEqual(result, { status: 'ignored' });
}

function assertAgentRunError(fn: () => unknown, code: AgentRunErrorCode): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AgentRunError);
    assert.equal(error.code, code);
    return true;
  });
}

function eventTypes(harness: Harness): string[] {
  return harness.sink.getEvents().map((event) => event.eventType);
}

describe('AgentRunCoordinator start and identity', () => {
  it('starts a running run with injected clock, opaque id, and generation 1', () => {
    const harness = createHarness(5_000);
    const snapshot = start(harness, 'tab-a', 'enable dark mode');

    assert.equal(snapshot.state, 'running');
    assert.equal(snapshot.runId, 'run-1');
    assert.equal(snapshot.tabId, 'tab-a');
    assert.equal(snapshot.generation, 1);
    assert.equal(snapshot.startedAt, 5_000);
    assert.equal(snapshot.instruction, 'enable dark mode');
    assert.equal(snapshot.modelStepCount, 0);
    assert.equal(snapshot.actionAttemptCount, 0);
    assert.equal(snapshot.approvalCount, 0);
    assert.equal(snapshot.terminalReason, undefined);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-a')?.runId, 'run-1');
    assert.equal(harness.coordinator.isCurrentRun(refOf(snapshot)), true);
    assert.equal(eventTypes(harness)[0], 'run-started');
  });

  it('returns immutable snapshots that cannot mutate coordinator state', () => {
    const harness = createHarness();
    const snapshot = start(harness);
    assert.throws(() => {
      (snapshot as { state: string }).state = 'failed';
    });
    assert.throws(() => {
      (snapshot as { modelStepCount: number }).modelStepCount = 99;
    });
    assert.equal(harness.coordinator.getRun(snapshot.runId)?.state, 'running');
    assert.equal(harness.coordinator.getRun(snapshot.runId)?.modelStepCount, 0);
  });

  it('keeps different tabs independent with separate generation sequences', () => {
    const harness = createHarness();
    const tabA1 = start(harness, 'tab-a');
    const tabB1 = start(harness, 'tab-b');
    const tabA2 = start(harness, 'tab-a', 'second');

    assert.equal(tabA1.generation, 1);
    assert.equal(tabB1.generation, 1);
    assert.equal(tabA2.generation, 2);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-a')?.runId, tabA2.runId);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-b')?.runId, tabB1.runId);
    assert.equal(harness.coordinator.getRun(tabA1.runId)?.state, 'cancelled');
    assert.equal(harness.coordinator.getRun(tabA1.runId)?.terminalReason, 'SUPERSEDED');
    assert.equal(harness.coordinator.getRun(tabB1.runId)?.state, 'running');
  });
});

describe('AgentRunCoordinator same-tab supersede', () => {
  it('cancels the previous active run as SUPERSEDED and advances generation', () => {
    const harness = createHarness();
    const first = start(harness);
    const awaiting = requireApplied(harness.coordinator.presentApproval(refOf(first), 'appr-1'));
    assert.equal(awaiting.state, 'awaiting-approval');

    const second = start(harness, 'tab-1', 'new task');
    const firstAfter = harness.coordinator.getRun(first.runId);
    assert.ok(firstAfter);
    assert.equal(firstAfter.state, 'cancelled');
    assert.equal(firstAfter.terminalReason, 'SUPERSEDED');
    assert.equal(second.state, 'running');
    assert.equal(second.generation, first.generation + 1);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1')?.runId, second.runId);
    assert.equal(harness.coordinator.getRunRefForApproval('appr-1'), undefined);
    assert.equal(harness.coordinator.isCurrentRun(refOf(first)), false);
    assert.equal(harness.coordinator.inspectRun(refOf(first)).status, 'superseded');
  });
});

describe('AgentRunCoordinator transactional start failure', () => {
  it('leaves the existing run unchanged when generateRunId throws', () => {
    let fail = false;
    const coordinator = new AgentRunCoordinator({
      now: () => 1_000,
      generateRunId: () => {
        if (fail) {
          throw new Error('run-id-failed');
        }
        return 'run-existing';
      },
    });
    const existing = coordinator.startRun('tab-1', 'keep going');
    fail = true;
    assert.throws(() => coordinator.startRun('tab-1', 'replacement'), /run-id-failed/);
    assert.equal(coordinator.getActiveRunForTab('tab-1')?.runId, existing.runId);
    assert.equal(coordinator.getRun(existing.runId)?.state, 'running');
    assert.equal(coordinator.getRun(existing.runId)?.generation, 1);
  });

  it('does not supersede when the generated id is empty or whitespace', () => {
    const harness = createHarness();
    const existing = start(harness);
    harness.setNextRunId('');
    assertAgentRunError(() => start(harness, 'tab-1', 'next'), 'INVALID_AGENT_RUN_ID');
    harness.setNextRunId('   ');
    assertAgentRunError(() => start(harness, 'tab-1', 'next'), 'INVALID_AGENT_RUN_ID');
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1')?.runId, existing.runId);
    assert.equal(harness.coordinator.getRun(existing.runId)?.state, 'running');
    assert.equal(harness.coordinator.getRun(existing.runId)?.generation, 1);
  });

  it('does not supersede or install a partial run on duplicate runId', () => {
    const harness = createHarness();
    const existing = start(harness);
    harness.setNextRunId(existing.runId);
    assertAgentRunError(() => start(harness, 'tab-1', 'next'), 'AGENT_RUN_ID_COLLISION');
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1')?.runId, existing.runId);
    assert.equal(harness.coordinator.getRun(existing.runId)?.state, 'running');
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1')?.generation, 1);
    assert.equal(harness.coordinator.getRun('run-2'), undefined);
  });
});

describe('AgentRunCoordinator state machine', () => {
  it('allows running to completed, cancelled, blocked, failed, unknown, and awaiting-approval', () => {
    const cases: Array<() => void> = [
      () => {
        const harness = createHarness();
        const run = start(harness);
        const done = requireApplied(harness.coordinator.markCompleted(refOf(run)));
        assert.equal(done.state, 'completed');
        assert.equal(done.terminalReason, 'COMPLETED');
      },
      () => {
        const harness = createHarness();
        const run = start(harness);
        const cancelled = requireApplied(
          harness.coordinator.cancelRun(refOf(run), 'USER_CANCELLED'),
        );
        assert.equal(cancelled.state, 'cancelled');
      },
      () => {
        const harness = createHarness();
        const run = start(harness);
        const blocked = requireApplied(
          harness.coordinator.markBlocked(refOf(run), 'POLICY_BLOCKED'),
        );
        assert.equal(blocked.state, 'blocked');
      },
      () => {
        const harness = createHarness();
        const run = start(harness);
        const failed = requireApplied(harness.coordinator.markFailed(refOf(run), 'MODEL_FAILED'));
        assert.equal(failed.state, 'failed');
      },
      () => {
        const harness = createHarness();
        const run = start(harness);
        const unknown = requireApplied(harness.coordinator.markExecutionStateUnknown(refOf(run)));
        assert.equal(unknown.state, 'execution-state-unknown');
        assert.equal(unknown.terminalReason, 'EXECUTION_STATE_UNKNOWN');
      },
      () => {
        const harness = createHarness();
        const run = start(harness);
        const awaiting = requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
        assert.equal(awaiting.state, 'awaiting-approval');
        assert.equal(awaiting.approvalCount, 1);
      },
    ];
    for (const runCase of cases) {
      runCase();
    }
  });

  it('allows awaiting-approval to running, cancelled, blocked, failed, and unknown', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    const resumed = requireApplied(
      harness.coordinator.resumeAfterApprovedExecution('appr-1', run.generation),
    );
    assert.equal(resumed.state, 'running');
    assert.equal(harness.coordinator.getRunRefForApproval('appr-1'), undefined);

    const blockedHarness = createHarness();
    const blockedRun = start(blockedHarness);
    requireApplied(blockedHarness.coordinator.presentApproval(refOf(blockedRun), 'appr-2'));
    assert.equal(
      requireApplied(
        blockedHarness.coordinator.markBlocked(refOf(blockedRun), 'APPROVAL_REJECTED'),
      ).state,
      'blocked',
    );

    const expiredHarness = createHarness();
    const expiredRun = start(expiredHarness);
    requireApplied(expiredHarness.coordinator.presentApproval(refOf(expiredRun), 'appr-3'));
    assert.equal(
      requireApplied(
        expiredHarness.coordinator.markBlocked(refOf(expiredRun), 'APPROVAL_EXPIRED'),
      ).state,
      'blocked',
    );

    const cancelHarness = createHarness();
    const cancelRun = start(cancelHarness);
    requireApplied(cancelHarness.coordinator.presentApproval(refOf(cancelRun), 'appr-4'));
    assert.equal(
      requireApplied(cancelHarness.coordinator.cancelRun(refOf(cancelRun), 'USER_CANCELLED')).state,
      'cancelled',
    );
    assert.equal(cancelHarness.coordinator.getRunRefForApproval('appr-4'), undefined);

    const failHarness = createHarness();
    const failRun = start(failHarness);
    requireApplied(failHarness.coordinator.presentApproval(refOf(failRun), 'appr-5'));
    assert.equal(
      requireApplied(failHarness.coordinator.markFailed(refOf(failRun), 'ACTION_FAILED')).state,
      'failed',
    );

    const unknownHarness = createHarness();
    const unknownRun = start(unknownHarness);
    requireApplied(unknownHarness.coordinator.presentApproval(refOf(unknownRun), 'appr-6'));
    assert.equal(
      requireApplied(unknownHarness.coordinator.markExecutionStateUnknown(refOf(unknownRun))).state,
      'execution-state-unknown',
    );
    assert.equal(unknownHarness.coordinator.getRunRefForApproval('appr-6'), undefined);
  });

  it('rejects transitions out of terminal states on the current generation', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.markCompleted(refOf(run)));
    assertAgentRunError(
      () => harness.coordinator.markFailed(refOf(run), 'MODEL_FAILED'),
      'AGENT_RUN_INVALID_TRANSITION',
    );
    assertAgentRunError(
      () => harness.coordinator.cancelRun(refOf(run), 'USER_CANCELLED'),
      'AGENT_RUN_INVALID_TRANSITION',
    );
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'completed');
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1'), undefined);
  });

  it('rejects completed from awaiting-approval', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    assertAgentRunError(
      () => harness.coordinator.markCompleted(refOf(run)),
      'AGENT_RUN_INVALID_TRANSITION',
    );
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'awaiting-approval');
  });
});

describe('AgentRunCoordinator late-result protection', () => {
  it('ignores late mutations from a superseded generation without touching either run', () => {
    const harness = createHarness();
    const first = start(harness);
    const second = start(harness, 'tab-1', 'newer');

    assertIgnored(harness.coordinator.markCompleted(refOf(first)));
    assertIgnored(harness.coordinator.recordModelStepCompleted(refOf(first)));
    assertIgnored(harness.coordinator.beginActionAttempt(refOf(first)));
    assertIgnored(harness.coordinator.presentApproval(refOf(first), 'appr-late'));

    assert.equal(harness.coordinator.getRun(first.runId)?.state, 'cancelled');
    assert.equal(harness.coordinator.getRun(first.runId)?.terminalReason, 'SUPERSEDED');
    assert.equal(harness.coordinator.getRun(second.runId)?.state, 'running');
    assert.equal(harness.coordinator.getRun(second.runId)?.modelStepCount, 0);
    assert.equal(harness.coordinator.getRun(second.runId)?.approvalCount, 0);
    assert.equal(harness.coordinator.isCurrentRun(refOf(first)), false);
    assert.equal(harness.coordinator.isCurrentRun(refOf(second)), true);
  });

  it('ignores a late approval resume after supersede', () => {
    const harness = createHarness();
    const first = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(first), 'appr-old'));
    const second = start(harness, 'tab-1', 'newer');

    assertIgnored(harness.coordinator.resumeAfterApprovedExecution('appr-old', first.generation));
    assert.equal(harness.coordinator.getRun(first.runId)?.state, 'cancelled');
    assert.equal(harness.coordinator.getRun(second.runId)?.state, 'running');
    assert.equal(harness.coordinator.getRunRefForApproval('appr-old'), undefined);
  });
});

describe('AgentRunCoordinator budgets', () => {
  it('records the eighth model step while remaining running, then blocks the next precheck', () => {
    const harness = createHarness();
    const run = start(harness);
    let current = refOf(run);
    for (let step = 1; step <= 7; step += 1) {
      requireApplied(harness.coordinator.assertCanStartModelStep(current));
      const recorded = requireApplied(harness.coordinator.recordModelStepCompleted(current));
      assert.equal(recorded.modelStepCount, step);
      assert.equal(recorded.state, 'running');
    }

    requireApplied(harness.coordinator.assertCanStartModelStep(current));
    const eighth = requireApplied(harness.coordinator.recordModelStepCompleted(current));
    assert.equal(eighth.modelStepCount, MAX_AGENT_LOOP_MODEL_STEPS);
    assert.equal(eighth.state, 'running');

    const blocked = requireApplied(harness.coordinator.assertCanStartModelStep(current));
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'STEP_LIMIT_REACHED');
    assert.equal(blocked.modelStepCount, MAX_AGENT_LOOP_MODEL_STEPS);
    assert.equal(harness.coordinator.getRun(run.runId)?.modelStepCount, 8);
  });

  it('allows six action attempts and blocks a seventh without incrementing past the cap', () => {
    const harness = createHarness();
    const run = start(harness);
    const current = refOf(run);
    for (let attempt = 1; attempt <= MAX_AGENT_LOOP_ACTION_ATTEMPTS; attempt += 1) {
      const started = requireApplied(harness.coordinator.beginActionAttempt(current));
      assert.equal(started.actionAttemptCount, attempt);
      assert.equal(started.state, 'running');
    }
    const blocked = requireApplied(harness.coordinator.beginActionAttempt(current));
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'STEP_LIMIT_REACHED');
    assert.equal(blocked.actionAttemptCount, MAX_AGENT_LOOP_ACTION_ATTEMPTS);
  });

  it('blocks approval presentation when action or approval budget is exhausted, without binding', () => {
    const harness = createHarness();
    const run = start(harness);
    let current = refOf(run);
    requireApplied(harness.coordinator.presentApproval(current, 'appr-1'));
    requireApplied(harness.coordinator.resumeAfterApprovedExecution('appr-1', run.generation));
    requireApplied(harness.coordinator.presentApproval(current, 'appr-2'));
    requireApplied(harness.coordinator.resumeAfterApprovedExecution('appr-2', run.generation));

    assert.equal(harness.coordinator.getRun(run.runId)?.approvalCount, MAX_AGENT_LOOP_APPROVALS);
    assert.equal(harness.coordinator.canPrepareAnotherAction(current), false);
    const blocked = requireApplied(harness.coordinator.presentApproval(current, 'appr-3'));
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'STEP_LIMIT_REACHED');
    assert.equal(blocked.approvalCount, 2);
    assert.equal(harness.coordinator.getRunRefForApproval('appr-3'), undefined);

    const actionHarness = createHarness();
    const actionRun = start(actionHarness);
    const actionRef = refOf(actionRun);
    for (let attempt = 0; attempt < MAX_AGENT_LOOP_ACTION_ATTEMPTS; attempt += 1) {
      requireApplied(actionHarness.coordinator.beginActionAttempt(actionRef));
    }
    assert.equal(actionHarness.coordinator.canPrepareAnotherAction(actionRef), false);
    const actionBlocked = requireApplied(
      actionHarness.coordinator.presentApproval(actionRef, 'appr-dead'),
    );
    assert.equal(actionBlocked.state, 'blocked');
    assert.equal(actionBlocked.approvalCount, 0);
    assert.equal(actionHarness.coordinator.getRunRefForApproval('appr-dead'), undefined);
  });

  it('does not increment action count when asserting remaining budget', () => {
    const harness = createHarness();
    const run = start(harness);
    const available = requireApplied(harness.coordinator.assertActionBudgetAvailable(refOf(run)));
    assert.equal(available.actionAttemptCount, 0);
    assert.equal(available.state, 'running');
  });
});

describe('AgentRunCoordinator approval correlation', () => {
  it('binds exactly one approvalId to the current run and clears it on resume', () => {
    const harness = createHarness();
    const run = start(harness);
    const awaiting = requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    assert.equal(awaiting.state, 'awaiting-approval');
    assert.equal(awaiting.approvalCount, 1);
    const binding = harness.coordinator.getRunRefForApproval('appr-1');
    assert.deepEqual(binding, { runId: run.runId, tabId: run.tabId, generation: run.generation });
    assert.equal(Object.isFrozen(binding), true);

    const resumed = requireApplied(
      harness.coordinator.resumeAfterApprovedExecution('appr-1', run.generation),
    );
    assert.equal(resumed.state, 'running');
    assert.equal(harness.coordinator.getRunRefForApproval('appr-1'), undefined);
  });

  it('fails closed on duplicate approvalId without overwriting the existing mapping', () => {
    const harness = createHarness();
    const first = start(harness, 'tab-a');
    requireApplied(harness.coordinator.presentApproval(refOf(first), 'shared-appr'));
    const second = start(harness, 'tab-b');
    assertAgentRunError(
      () => harness.coordinator.presentApproval(refOf(second), 'shared-appr'),
      'APPROVAL_CORRELATION_COLLISION',
    );
    assert.equal(harness.coordinator.getRun(second.runId)?.state, 'running');
    assert.equal(harness.coordinator.getRun(second.runId)?.approvalCount, 0);
    assert.equal(harness.coordinator.getRunRefForApproval('shared-appr')?.runId, first.runId);
  });

  it('rolls back nothing when approval id is empty or whitespace', () => {
    const harness = createHarness();
    const run = start(harness);
    assertAgentRunError(
      () => harness.coordinator.presentApproval(refOf(run), ''),
      'INVALID_APPROVAL_ID',
    );
    assertAgentRunError(
      () => harness.coordinator.presentApproval(refOf(run), '  '),
      'INVALID_APPROVAL_ID',
    );
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'running');
    assert.equal(harness.coordinator.getRun(run.runId)?.approvalCount, 0);
    assert.equal(harness.coordinator.getRunRefForApproval(''), undefined);
  });

  it('clears correlation when an awaiting run is terminalized', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    requireApplied(harness.coordinator.markBlocked(refOf(run), 'ACTION_STALE'));
    assert.equal(harness.coordinator.getRunRefForApproval('appr-1'), undefined);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1'), undefined);
  });
});

describe('AgentRunCoordinator no-progress fingerprint', () => {
  it('blocks an immediate repeat of the last successful fingerprint without consuming action budget', () => {
    const harness = createHarness();
    const run = start(harness);
    const current = refOf(run);
    const click = fingerprintAction({
      kind: 'click',
      documentRevision: 'rev-1',
      targetId: 'target-a',
    });
    requireApplied(harness.coordinator.recordSuccessfulActionFingerprint(current, click));
    const blocked = requireApplied(harness.coordinator.assertNoImmediateRepeat(current, click));
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'AGENT_LOOP_NO_PROGRESS');
    assert.equal(blocked.actionAttemptCount, 0);
  });

  it('allows a different target or a later document revision of the same control', () => {
    const harness = createHarness();
    const run = start(harness);
    const current = refOf(run);
    const clickA = fingerprintAction({
      kind: 'click',
      documentRevision: 'rev-1',
      targetId: 'target-a',
    });
    requireApplied(harness.coordinator.recordSuccessfulActionFingerprint(current, clickA));
    const otherTarget = fingerprintAction({
      kind: 'click',
      documentRevision: 'rev-1',
      targetId: 'target-b',
    });
    const allowedTarget = requireApplied(
      harness.coordinator.assertNoImmediateRepeat(current, otherTarget),
    );
    assert.equal(allowedTarget.state, 'running');

    const laterRevision = fingerprintAction({
      kind: 'click',
      documentRevision: 'rev-2',
      targetId: 'target-a',
    });
    const allowedRevision = requireApplied(
      harness.coordinator.assertNoImmediateRepeat(current, laterRevision),
    );
    assert.equal(allowedRevision.state, 'running');
  });

  it('does not persist typed payload in snapshots or audit, and failed actions do not update last success', () => {
    const secret = 'typed-secret-payload';
    const harness = createHarness();
    const run = start(harness, 'tab-1', 'fill the field');
    const current = refOf(run);
    const digest = fingerprintAction({
      kind: 'type',
      documentRevision: 'rev-1',
      targetId: 'target-a',
      text: secret,
    });
    requireApplied(harness.coordinator.recordSuccessfulActionFingerprint(current, digest));
    const snapshot = harness.coordinator.getRun(run.runId);
    assert.ok(snapshot);
    assert.equal(snapshot.lastSuccessfulActionFingerprint, digest);
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal(JSON.stringify(harness.sink.getEvents()).includes(secret), false);
    assert.equal(JSON.stringify(harness.sink.getEvents()).includes(digest), false);

    requireApplied(harness.coordinator.markFailed(current, 'ACTION_FAILED'));
    assert.equal(
      harness.coordinator.getRun(run.runId)?.lastSuccessfulActionFingerprint,
      digest,
    );
  });
});

describe('AgentRunCoordinator audit and lifecycle', () => {
  it('records started, transition, model, action, approval, and terminal events', () => {
    const harness = createHarness();
    const run = start(harness);
    const current = refOf(run);
    requireApplied(harness.coordinator.recordModelStepCompleted(current));
    requireApplied(harness.coordinator.beginActionAttempt(current));
    requireApplied(harness.coordinator.presentApproval(current, 'appr-1'));
    requireApplied(harness.coordinator.markBlocked(current, 'APPROVAL_REJECTED'));
    assert.deepEqual(eventTypes(harness), [
      'run-started',
      'model-step-completed',
      'action-attempt-started',
      'state-transition',
      'approval-presented',
      'state-transition',
      'run-terminal',
    ]);
    for (const event of harness.sink.getEvents()) {
      assert.equal('instruction' in event, false);
      assert.equal('approvalId' in event, false);
    }
  });

  it('keeps a newly installed run when start audit throws', () => {
    const sink: AgentRunAuditSink = {
      append() {
        throw new Error('audit-down');
      },
      getEvents() {
        return Object.freeze([]);
      },
      clear() {},
    };
    const coordinator = new AgentRunCoordinator({
      now: () => 1_000,
      generateRunId: () => 'run-1',
      auditSink: sink,
    });
    const snapshot = coordinator.startRun('tab-1', 'keep running');
    assert.equal(snapshot.state, 'running');
    assert.equal(coordinator.getActiveRunForTab('tab-1')?.runId, 'run-1');
  });

  it('does not revive a terminal run when terminal audit throws', () => {
    const sink: AgentRunAuditSink = {
      append() {
        throw new Error('audit-down');
      },
      getEvents() {
        return Object.freeze([]);
      },
      clear() {},
    };
    const coordinator = new AgentRunCoordinator({
      now: () => 1_000,
      generateRunId: () => 'run-1',
      auditSink: sink,
    });
    const snapshot = coordinator.startRun('tab-1', 'finish');
    const completed = requireApplied(coordinator.markCompleted(refOf(snapshot)));
    assert.equal(completed.state, 'completed');
    assert.equal(coordinator.getActiveRunForTab('tab-1'), undefined);
    assert.equal(coordinator.getRun(snapshot.runId)?.state, 'completed');
  });

  it('clearTab terminalizes the active run, drops records, and does not affect other tabs', () => {
    const harness = createHarness();
    const first = start(harness, 'tab-1');
    requireApplied(harness.coordinator.presentApproval(refOf(first), 'appr-1'));
    const other = start(harness, 'tab-2');
    harness.coordinator.clearTab('tab-1');
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1'), undefined);
    assert.equal(harness.coordinator.getRun(first.runId), undefined);
    assert.equal(harness.coordinator.isCurrentRun(refOf(first)), false);
    assert.equal(harness.coordinator.getRunRefForApproval('appr-1'), undefined);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-2')?.runId, other.runId);
  });

  it('clearAll drops every ephemeral run and approval correlation', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    start(harness, 'tab-2');
    harness.coordinator.clearAll();
    assert.equal(harness.coordinator.getRun(run.runId), undefined);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1'), undefined);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-2'), undefined);
    assert.equal(harness.coordinator.getRunRefForApproval('appr-1'), undefined);
  });
});

describe('AgentRunCoordinator approval waiters and trusted outcomes', () => {
  it('wakes the exact waiter when executed and ignores a duplicate outcome', async () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    const pending = harness.coordinator.waitForApprovalOutcome('appr-1', run.generation);
    const first = requireApplied(harness.coordinator.notifyApprovalOutcome('appr-1', 'executed'));
    assert.equal(first.state, 'running');
    const waited = await pending;
    assert.equal(waited.status, 'resolved');
    if (waited.status === 'resolved') {
      assert.equal(waited.snapshot.state, 'running');
    }
    assertIgnored(harness.coordinator.notifyApprovalOutcome('appr-1', 'stale'));
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'running');
  });

  it('maps reject, expiry, stale, failed, and unknown outcomes', () => {
    const cases: Array<{
      outcome: 'rejected' | 'expired' | 'stale' | 'failed' | 'execution-state-unknown';
      state: AgentRunSnapshot['state'];
      reason: string;
    }> = [
      { outcome: 'rejected', state: 'blocked', reason: 'APPROVAL_REJECTED' },
      { outcome: 'expired', state: 'blocked', reason: 'APPROVAL_EXPIRED' },
      { outcome: 'stale', state: 'blocked', reason: 'ACTION_STALE' },
      { outcome: 'failed', state: 'failed', reason: 'ACTION_FAILED' },
      {
        outcome: 'execution-state-unknown',
        state: 'execution-state-unknown',
        reason: 'EXECUTION_STATE_UNKNOWN',
      },
    ];
    for (const testCase of cases) {
      const harness = createHarness();
      const run = start(harness);
      requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
      const snapshot = requireApplied(
        harness.coordinator.notifyApprovalOutcome('appr-1', testCase.outcome),
      );
      assert.equal(snapshot.state, testCase.state);
      assert.equal(snapshot.terminalReason, testCase.reason);
      assertIgnored(harness.coordinator.notifyApprovalOutcome('appr-1', 'executed'));
    }
  });

  it('does not resume a superseded run from a late executed outcome', async () => {
    const harness = createHarness();
    const first = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(first), 'appr-old'));
    const pending = harness.coordinator.waitForApprovalOutcome('appr-old', first.generation);
    const second = start(harness, 'tab-1', 'newer');
    const waited = await pending;
    assert.equal(waited.status, 'resolved');
    if (waited.status === 'resolved') {
      assert.equal(waited.snapshot.terminalReason, 'SUPERSEDED');
    }
    assertIgnored(harness.coordinator.notifyApprovalOutcome('appr-old', 'executed'));
    assert.equal(harness.coordinator.getRun(first.runId)?.state, 'cancelled');
    assert.equal(harness.coordinator.getRun(second.runId)?.state, 'running');
    assert.equal(harness.coordinator.getRun(second.runId)?.actionAttemptCount, 0);
  });

  it('beginApprovedExecution proceeds only for the correlated awaiting run', () => {
    const harness = createHarness();
    assert.equal(harness.coordinator.beginApprovedExecution('missing'), 'unrelated');
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    assert.equal(harness.coordinator.beginApprovedExecution('appr-1'), 'proceed');
    assert.equal(harness.coordinator.getRun(run.runId)?.actionAttemptCount, 1);
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'awaiting-approval');

    const blockedHarness = createHarness();
    const blockedRun = start(blockedHarness);
    for (let i = 0; i < MAX_AGENT_LOOP_ACTION_ATTEMPTS - 1; i += 1) {
      requireApplied(blockedHarness.coordinator.beginActionAttempt(refOf(blockedRun)));
    }
    requireApplied(blockedHarness.coordinator.presentApproval(refOf(blockedRun), 'appr-full'));
    requireApplied(blockedHarness.coordinator.beginActionAttempt(refOf(blockedRun)));
    assert.equal(blockedHarness.coordinator.beginApprovedExecution('appr-full'), 'blocked');
    assert.equal(blockedHarness.coordinator.getRun(blockedRun.runId)?.state, 'blocked');
    assert.equal(
      blockedHarness.coordinator.getRun(blockedRun.runId)?.terminalReason,
      'STEP_LIMIT_REACHED',
    );
    assert.equal(
      blockedHarness.coordinator.getRun(blockedRun.runId)?.actionAttemptCount,
      MAX_AGENT_LOOP_ACTION_ATTEMPTS,
    );
  });

  it('returns ignored from beginApprovedExecution after the run is superseded', () => {
    const harness = createHarness();
    const first = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(first), 'appr-1'));
    start(harness, 'tab-1', 'newer');
    assert.equal(harness.coordinator.beginApprovedExecution('appr-1'), 'ignored');
  });

  it('waitForApprovalOutcome ignores unknown or generation-mismatched approvals', async () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    const ignoredUnknown = await harness.coordinator.waitForApprovalOutcome('missing', run.generation);
    const ignoredGeneration = await harness.coordinator.waitForApprovalOutcome('appr-1', run.generation + 1);
    assert.equal(ignoredUnknown.status, 'ignored');
    assert.equal(ignoredGeneration.status, 'ignored');
  });

  it('resolves a waiter when the awaiting run is cancelled', async () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    const pending = harness.coordinator.waitForApprovalOutcome('appr-1', run.generation);
    requireApplied(harness.coordinator.cancelRun(refOf(run), 'USER_CANCELLED'));
    const waited = await pending;
    assert.equal(waited.status, 'resolved');
    if (waited.status === 'resolved') {
      assert.equal(waited.snapshot.terminalReason, 'USER_CANCELLED');
    }
  });

  it('requestCancellationAfterDispatch keeps the run awaiting until executed then cancels', async () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    const pending = harness.coordinator.waitForApprovalOutcome('appr-1', run.generation);
    requireApplied(harness.coordinator.requestCancellationAfterDispatch(refOf(run), 'USER_CANCELLED'));
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'awaiting-approval');
    assert.equal(harness.coordinator.beginApprovedExecution('appr-1'), 'proceed');
    requireApplied(harness.coordinator.notifyApprovalOutcome('appr-1', 'executed'));
    const waited = await pending;
    assert.equal(waited.status, 'resolved');
    if (waited.status === 'resolved') {
      assert.equal(waited.snapshot.state, 'cancelled');
      assert.equal(waited.snapshot.terminalReason, 'USER_CANCELLED');
    }
    assert.equal(harness.coordinator.hasApprovalWaiter('appr-1'), false);
  });

  it('requestCancellationAfterDispatch yields unknown when V4 outcome is unknown', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(run), 'appr-1'));
    requireApplied(harness.coordinator.requestCancellationAfterDispatch(refOf(run), 'USER_CANCELLED'));
    assert.equal(harness.coordinator.beginApprovedExecution('appr-1'), 'proceed');
    const result = requireApplied(
      harness.coordinator.notifyApprovalOutcome('appr-1', 'execution-state-unknown'),
    );
    assert.equal(result.state, 'execution-state-unknown');
    assert.equal(result.terminalReason, 'EXECUTION_STATE_UNKNOWN');
    assert.equal(harness.coordinator.hasApprovalWaiter('appr-1'), false);
  });

  it('keeps a superseded approval waiter until V4 notifies a terminal outcome', () => {
    const harness = createHarness();
    const first = start(harness);
    requireApplied(harness.coordinator.presentApproval(refOf(first), 'appr-1'));
    start(harness, 'tab-1', 'newer');
    assert.equal(harness.coordinator.beginApprovedExecution('appr-1'), 'ignored');
    assert.equal(harness.coordinator.hasApprovalWaiter('appr-1'), true);
    assertIgnored(harness.coordinator.notifyApprovalOutcome('appr-1', 'stale'));
    assert.equal(harness.coordinator.hasApprovalWaiter('appr-1'), false);
    assert.equal(harness.coordinator.beginApprovedExecution('appr-1'), 'unrelated');
  });
});

describe('AgentRunCoordinator causal popup continuation', () => {
  it('adopts only the exact destination tab onto the same run', () => {
    const harness = createHarness();
    const run = start(harness);
    const adopted = requireApplied(harness.coordinator.adoptCausalPopup(refOf(run), 'tab-dest'));
    assert.equal(adopted.executionTabId, 'tab-dest');
    assert.equal(adopted.tabId, 'tab-1');
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1')?.runId, run.runId);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-dest')?.runId, run.runId);
    assert.equal(harness.coordinator.inspectRun(refOf(run)).status, 'current');
  });

  it('does not adopt a destination already owned independently by another run', () => {
    const harness = createHarness();
    const origin = start(harness, 'tab-1');
    const other = start(harness, 'tab-other');
    requireApplied(harness.coordinator.adoptCausalPopup(refOf(origin), 'tab-dest'));
    assert.equal(harness.coordinator.getActiveRunForTab('tab-other')?.runId, other.runId);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-dest')?.runId, origin.runId);
    assert.notEqual(harness.coordinator.getActiveRunForTab('tab-dest')?.runId, other.runId);
  });

  it('does not transfer ownership for a popup from an unrelated tab', () => {
    const harness = createHarness();
    const run = start(harness, 'tab-1');
    assert.equal(harness.coordinator.getActiveRunForTab('tab-unrelated'), undefined);
    assert.equal(harness.coordinator.getRun(run.runId)?.executionTabId, undefined);
  });

  it('blocks a repeat origin click after causal popup adoption', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.adoptCausalPopup(refOf(run), 'tab-dest'));
    const blocked = harness.coordinator.assertNotRepeatOriginPopupClick(refOf(run), 'tab-1', 'click');
    assert.equal(blocked.status, 'applied');
    if (blocked.status === 'applied') {
      assert.equal(blocked.snapshot.state, 'blocked');
      assert.equal(blocked.snapshot.terminalReason, 'AGENT_LOOP_NO_PROGRESS');
    }
  });

  it('allows a later click on the adopted destination tab', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.adoptCausalPopup(refOf(run), 'tab-dest'));
    const allowed = harness.coordinator.assertNotRepeatOriginPopupClick(
      refOf(run),
      'tab-dest',
      'click',
    );
    assert.equal(allowed.status, 'applied');
    if (allowed.status === 'applied') {
      assert.equal(allowed.snapshot.state, 'running');
    }
  });

  it('cancels the unique run when the adopted destination tab is closed', () => {
    const harness = createHarness();
    const run = start(harness);
    requireApplied(harness.coordinator.adoptCausalPopup(refOf(run), 'tab-dest'));
    harness.coordinator.clearTab('tab-dest');
    assert.equal(harness.coordinator.getRun(run.runId), undefined);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1'), undefined);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-dest'), undefined);
  });

  it('supersedes the origin run when a new Act starts on the adopted destination', () => {
    const harness = createHarness();
    const origin = start(harness, 'tab-1', 'open popup');
    requireApplied(harness.coordinator.adoptCausalPopup(refOf(origin), 'tab-dest'));
    const next = start(harness, 'tab-dest', 'new task on dest');
    assert.equal(harness.coordinator.getRun(origin.runId)?.state, 'cancelled');
    assert.equal(harness.coordinator.getRun(origin.runId)?.terminalReason, 'SUPERSEDED');
    assert.equal(next.state, 'running');
    assert.equal(harness.coordinator.getActiveRunForTab('tab-dest')?.runId, next.runId);
    assert.equal(harness.coordinator.getActiveRunForTab('tab-1'), undefined);
  });
});

describe('AgentRunCoordinator isolation', () => {
  it('does not import browser, approval, model, Electron, React, or IPC surfaces', () => {
    const dir = path.join(__dirname);
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const forbidden = [
      'BrowserAdapter',
      'ElectronBrowserAdapter',
      'InteractionExecutor',
      'ExecuteExecutor',
      'ApprovalManager',
      'PrepareActionService',
      'ApprovalWorkflowController',
      'ModelRuntime',
      'InteractiveAgent',
      'ReadOnlyAgent',
      'ipcMain',
      "from 'electron'",
      'from "electron"',
      "from 'react'",
      'from "react"',
      'WebContents',
      'ConversationStore',
    ];
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const needle of forbidden) {
        assert.equal(source.includes(needle), false, `${file} contains ${needle}`);
      }
    }
  });
});
