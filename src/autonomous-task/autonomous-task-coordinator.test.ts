import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { InMemoryAutonomousTaskAuditSink, type AutonomousTaskAuditSink } from './autonomous-task-audit';
import { AutonomousTaskCoordinator } from './autonomous-task-coordinator';
import { AutonomousTaskError, type AutonomousTaskErrorCode } from './autonomous-task-errors';
import {
  MAX_AUTONOMOUS_TASK_APPROVALS,
  MAX_AUTONOMOUS_TASK_CHILD_RUNS,
  MAX_AUTONOMOUS_TASK_OWNED_TABS,
  MAX_AUTONOMOUS_TASK_PLANNER_STEPS,
  toAutonomousTaskRef,
  type AutonomousTaskMutationResult,
  type AutonomousTaskRef,
  type AutonomousTaskSnapshot,
  type AutonomousTaskState,
} from './autonomous-task-types';
import { fingerprintSubgoal } from './task-no-progress';

interface Harness {
  coordinator: AutonomousTaskCoordinator;
  sink: InMemoryAutonomousTaskAuditSink;
  now: number;
  queuedTaskId: string | undefined;
  setNow(value: number): void;
  setNextTaskId(value: string): void;
}

function createHarness(startNow = 1_000): Harness {
  let taskSerial = 0;
  const harness: Harness = {
    now: startNow,
    queuedTaskId: undefined,
    sink: new InMemoryAutonomousTaskAuditSink(),
    coordinator: undefined as unknown as AutonomousTaskCoordinator,
    setNow(value: number) {
      harness.now = value;
    },
    setNextTaskId(value: string) {
      harness.queuedTaskId = value;
    },
  };
  harness.coordinator = new AutonomousTaskCoordinator({
    now: () => harness.now,
    generateTaskId: () => {
      if (harness.queuedTaskId !== undefined) {
        const id = harness.queuedTaskId;
        harness.queuedTaskId = undefined;
        return id;
      }
      taskSerial += 1;
      return `task-${taskSerial}`;
    },
    auditSink: harness.sink,
  });
  return harness;
}

function start(
  harness: Harness,
  tabId = 'tab-1',
  objective = 'compare these three plans',
): AutonomousTaskSnapshot {
  return harness.coordinator.startTask(tabId, objective);
}

function refOf(snapshot: AutonomousTaskSnapshot): AutonomousTaskRef {
  return toAutonomousTaskRef(snapshot);
}

function requireApplied(result: AutonomousTaskMutationResult): AutonomousTaskSnapshot {
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') {
    throw new Error('expected applied mutation');
  }
  return result.snapshot;
}

function assertIgnored(result: AutonomousTaskMutationResult): void {
  assert.deepEqual(result, { status: 'ignored' });
}

function assertTaskError(fn: () => unknown, code: AutonomousTaskErrorCode): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AutonomousTaskError);
    assert.equal(error.code, code);
    return true;
  });
}

function eventTypes(harness: Harness): string[] {
  return harness.sink.getEvents().map((event) => event.eventType);
}

function completeChild(harness: Harness, ref: AutonomousTaskRef): AutonomousTaskSnapshot {
  requireApplied(harness.coordinator.beginChildRun(ref));
  return requireApplied(harness.coordinator.markChildCompleted(ref));
}

describe('AutonomousTaskCoordinator start and identity', () => {
  it('starts a planning task with injected clock, opaque id, generation 1, and adopted starting tab', () => {
    const harness = createHarness(5_000);
    const snapshot = start(harness, 'tab-a', 'research hotels');

    assert.equal(snapshot.state, 'planning');
    assert.equal(snapshot.taskId, 'task-1');
    assert.equal(snapshot.startingTabId, 'tab-a');
    assert.equal(snapshot.generation, 1);
    assert.equal(snapshot.startedAt, 5_000);
    assert.equal(snapshot.objective, 'research hotels');
    assert.equal(snapshot.plannerStepCount, 0);
    assert.equal(snapshot.childRunCount, 0);
    assert.equal(snapshot.taskApprovalCount, 0);
    assert.equal(snapshot.ownedTabCount, 1);
    assert.equal(snapshot.terminalReason, undefined);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(harness.coordinator.getActiveTask()?.taskId, 'task-1');
    assert.equal(harness.coordinator.isCurrentTask(refOf(snapshot)), true);
    assert.equal(harness.coordinator.resolveTaskTabAlias('task-1', 'task-tab-1')?.tabId, 'tab-a');
    assert.equal(harness.coordinator.getOwnedTabs('task-1')[0]?.ownershipKind, 'adopted');
    assert.deepEqual(eventTypes(harness).slice(0, 2), ['task-started', 'task-tab-added']);
  });

  it('returns immutable snapshots that cannot mutate coordinator state', () => {
    const harness = createHarness();
    const snapshot = start(harness);
    assert.throws(() => {
      (snapshot as { state: string }).state = 'failed';
    });
    assert.throws(() => {
      (snapshot as { plannerStepCount: number }).plannerStepCount = 99;
    });
    assert.equal(harness.coordinator.getTask(snapshot.taskId)?.state, 'planning');
    assert.equal(harness.coordinator.getTask(snapshot.taskId)?.plannerStepCount, 0);
  });
});

describe('AutonomousTaskCoordinator transactional start failure', () => {
  it('leaves existing paused history unchanged when generateTaskId throws', () => {
    let fail = false;
    const coordinator = new AutonomousTaskCoordinator({
      now: () => 1_000,
      generateTaskId: () => {
        if (fail) {
          throw new Error('task-id-failed');
        }
        return 'task-existing';
      },
    });
    const existing = coordinator.startTask('tab-1', 'keep going');
    requireApplied(coordinator.pauseAtSafeBoundary(refOf(existing)));
    fail = true;
    assert.throws(() => coordinator.startTask('tab-2', 'replacement'), /task-id-failed/);
    assert.equal(coordinator.getActiveTask(), undefined);
    assert.equal(coordinator.getTask(existing.taskId)?.state, 'paused');
    assert.equal(coordinator.getTask(existing.taskId)?.generation, 1);
    assert.equal(coordinator.getOwnedTabs(existing.taskId).length, 1);
  });

  it('does not install a task when the generated id is empty or whitespace', () => {
    const harness = createHarness();
    const existing = start(harness);
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(existing)));
    harness.setNextTaskId('');
    assertTaskError(() => start(harness, 'tab-2', 'next'), 'INVALID_AUTONOMOUS_TASK_ID');
    harness.setNextTaskId('   ');
    assertTaskError(() => start(harness, 'tab-2', 'next'), 'INVALID_AUTONOMOUS_TASK_ID');
    assert.equal(harness.coordinator.getActiveTask(), undefined);
    assert.equal(harness.coordinator.getTask(existing.taskId)?.state, 'paused');
    assert.equal(harness.coordinator.getOwnedTabs(existing.taskId)[0]?.alias, 'task-tab-1');
  });

  it('does not install a partial task on duplicate taskId', () => {
    const harness = createHarness();
    const existing = start(harness);
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(existing)));
    harness.setNextTaskId(existing.taskId);
    assertTaskError(() => start(harness, 'tab-2', 'next'), 'AUTONOMOUS_TASK_ID_COLLISION');
    assert.equal(harness.coordinator.getActiveTask(), undefined);
    assert.equal(harness.coordinator.getTask(existing.taskId)?.state, 'paused');
    assert.equal(harness.coordinator.resolveTaskTabAlias('task-2', 'task-tab-1'), undefined);
  });

  it('rejects invalid starting tabs and empty objectives without mutating registry', () => {
    const harness = createHarness();
    assertTaskError(() => start(harness, '', 'objective'), 'INVALID_TAB_ID');
    assertTaskError(() => start(harness, '   ', 'objective'), 'INVALID_TAB_ID');
    assertTaskError(() => start(harness, 'tab-1', ''), 'INVALID_AUTONOMOUS_TASK_OBJECTIVE');
    assertTaskError(() => start(harness, 'tab-1', '   '), 'INVALID_AUTONOMOUS_TASK_OBJECTIVE');
    assert.equal(harness.coordinator.getActiveTask(), undefined);
    assert.equal(harness.coordinator.getOwnedTabs('task-1').length, 0);
  });

  it('rejects a starting tab already owned by a paused task', () => {
    const harness = createHarness();
    const existing = start(harness, 'tab-owned');
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(existing)));
    assertTaskError(
      () => start(harness, 'tab-owned', 'other objective'),
      'TASK_TAB_ALREADY_OWNED',
    );
    assert.equal(harness.coordinator.getActiveTask(), undefined);
    assert.equal(harness.coordinator.getTask(existing.taskId)?.state, 'paused');
    assert.equal(harness.coordinator.getOwnedTabs(existing.taskId)[0]?.tabId, 'tab-owned');
  });
});

describe('AutonomousTaskCoordinator active-task exclusivity', () => {
  it('fails closed when starting while another task is active', () => {
    const harness = createHarness();
    const first = start(harness, 'tab-a');
    assertTaskError(() => start(harness, 'tab-b', 'second'), 'AUTONOMOUS_TASK_ALREADY_ACTIVE');
    assert.equal(harness.coordinator.getActiveTask()?.taskId, first.taskId);
    assert.equal(harness.coordinator.getTask(first.taskId)?.state, 'planning');
    assert.equal(harness.coordinator.getOwnedTabs(first.taskId).length, 1);
  });

  it('allows a new task while a previous task is paused on another tab', () => {
    const harness = createHarness();
    const first = start(harness, 'tab-a');
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(first)));
    const second = start(harness, 'tab-b', 'second task');
    assert.equal(second.state, 'planning');
    assert.equal(harness.coordinator.getActiveTask()?.taskId, second.taskId);
    assert.equal(harness.coordinator.getTask(first.taskId)?.state, 'paused');
    assert.equal(harness.coordinator.inspectTask(refOf(first)).status, 'paused');
  });

  it('rejects Resume of a paused task while another task is active', () => {
    const harness = createHarness();
    const first = start(harness, 'tab-a');
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(first)));
    const second = start(harness, 'tab-b', 'second');
    assertTaskError(
      () => harness.coordinator.resumeTask(refOf(first)),
      'AUTONOMOUS_TASK_ALREADY_ACTIVE',
    );
    assert.equal(harness.coordinator.getTask(first.taskId)?.state, 'paused');
    assert.equal(harness.coordinator.getTask(first.taskId)?.generation, 1);
    assert.equal(harness.coordinator.getActiveTask()?.taskId, second.taskId);
    assert.equal(harness.coordinator.getTask(second.taskId)?.state, 'planning');
  });

  it('allows a new task after a previous task is terminal', () => {
    const harness = createHarness();
    const first = start(harness, 'tab-a');
    requireApplied(harness.coordinator.markCompleted(refOf(first)));
    const second = start(harness, 'tab-a', 'next');
    assert.equal(second.state, 'planning');
    assert.equal(harness.coordinator.getTask(first.taskId)?.state, 'completed');
    assert.equal(harness.coordinator.getOwnedTabs(first.taskId).length, 0);
    assert.equal(harness.coordinator.getActiveTask()?.taskId, second.taskId);
  });
});

describe('AutonomousTaskCoordinator state machine', () => {
  it('allows every planning transition from the locked matrix', () => {
    const cases: Array<{
      next: AutonomousTaskState;
      act: (coordinator: AutonomousTaskCoordinator, ref: AutonomousTaskRef) => AutonomousTaskMutationResult;
    }> = [
      { next: 'running-subgoal', act: (c, ref) => c.beginChildRun(ref) },
      { next: 'awaiting-user-input', act: (c, ref) => c.markAwaitingUserInput(ref) },
      { next: 'paused', act: (c, ref) => c.pauseAtSafeBoundary(ref) },
      { next: 'completed', act: (c, ref) => c.markCompleted(ref) },
      { next: 'cancelled', act: (c, ref) => c.cancelTask(ref) },
      { next: 'blocked', act: (c, ref) => c.markBlocked(ref, 'POLICY_BLOCKED') },
      { next: 'failed', act: (c, ref) => c.markFailed(ref, 'PLANNER_FAILED') },
      { next: 'execution-state-unknown', act: (c, ref) => c.markExecutionStateUnknown(ref) },
    ];
    for (const [index, entry] of cases.entries()) {
      const harness = createHarness();
      const task = start(harness, `tab-${index}`);
      const snapshot = requireApplied(entry.act(harness.coordinator, refOf(task)));
      assert.equal(snapshot.state, entry.next);
    }
  });

  it('allows every running-subgoal transition from the locked matrix', () => {
    const cases: Array<{
      next: AutonomousTaskState;
      act: (c: AutonomousTaskCoordinator, ref: AutonomousTaskRef) => AutonomousTaskMutationResult;
    }> = [
      { next: 'planning', act: (c, ref) => c.markChildCompleted(ref) },
      { next: 'awaiting-approval', act: (c, ref) => c.recordApprovalPresented(ref) },
      { next: 'paused', act: (c, ref) => c.pauseAtSafeBoundary(ref) },
      { next: 'cancelled', act: (c, ref) => c.cancelTask(ref) },
      { next: 'blocked', act: (c, ref) => c.markBlocked(ref, 'POLICY_BLOCKED') },
      { next: 'failed', act: (c, ref) => c.markFailed(ref, 'CHILD_RUN_FAILED') },
      { next: 'execution-state-unknown', act: (c, ref) => c.markExecutionStateUnknown(ref) },
    ];
    for (const entry of cases) {
      const harness = createHarness();
      const task = start(harness);
      const running = requireApplied(harness.coordinator.beginChildRun(refOf(task)));
      const snapshot = requireApplied(entry.act(harness.coordinator, refOf(running)));
      assert.equal(snapshot.state, entry.next);
    }
  });

  it('allows awaiting-approval transitions including safe-boundary pause', () => {
    const cases: Array<{
      next: AutonomousTaskState;
      act: (c: AutonomousTaskCoordinator, ref: AutonomousTaskRef) => AutonomousTaskMutationResult;
    }> = [
      { next: 'running-subgoal', act: (c, ref) => c.markApprovalExecuted(ref) },
      { next: 'paused', act: (c, ref) => c.pauseAtSafeBoundary(ref) },
      { next: 'cancelled', act: (c, ref) => c.cancelTask(ref) },
      { next: 'blocked', act: (c, ref) => c.markBlocked(ref, 'APPROVAL_REJECTED') },
      { next: 'failed', act: (c, ref) => c.markFailed(ref, 'CHILD_RUN_FAILED') },
      { next: 'execution-state-unknown', act: (c, ref) => c.markExecutionStateUnknown(ref) },
    ];
    for (const entry of cases) {
      const harness = createHarness();
      const task = start(harness);
      requireApplied(harness.coordinator.beginChildRun(refOf(task)));
      const awaiting = requireApplied(harness.coordinator.recordApprovalPresented(refOf(task)));
      const snapshot = requireApplied(entry.act(harness.coordinator, refOf(awaiting)));
      assert.equal(snapshot.state, entry.next);
    }
    const expiry = createHarness();
    const expiryTask = start(expiry);
    requireApplied(expiry.coordinator.beginChildRun(refOf(expiryTask)));
    requireApplied(expiry.coordinator.recordApprovalPresented(refOf(expiryTask)));
    assert.equal(
      requireApplied(expiry.coordinator.markBlocked(refOf(expiryTask), 'APPROVAL_EXPIRED')).terminalReason,
      'APPROVAL_EXPIRED',
    );
    const stale = createHarness();
    const staleTask = start(stale);
    requireApplied(stale.coordinator.beginChildRun(refOf(staleTask)));
    requireApplied(stale.coordinator.recordApprovalPresented(refOf(staleTask)));
    assert.equal(
      requireApplied(stale.coordinator.markBlocked(refOf(staleTask), 'ACTION_STALE')).terminalReason,
      'ACTION_STALE',
    );
  });

  it('allows awaiting-user-input to planning with a fresh generation, pause, and cancel', () => {
    const harness = createHarness();
    const task = start(harness);
    const waiting = requireApplied(harness.coordinator.markAwaitingUserInput(refOf(task)));
    assert.equal(waiting.state, 'awaiting-user-input');
    const resumed = requireApplied(harness.coordinator.resumeFromUserInput(refOf(waiting)));
    assert.equal(resumed.state, 'planning');
    assert.equal(resumed.generation, 2);

    const pausedHarness = createHarness();
    const pausedTask = start(pausedHarness);
    requireApplied(pausedHarness.coordinator.markAwaitingUserInput(refOf(pausedTask)));
    assert.equal(
      requireApplied(pausedHarness.coordinator.pauseAtSafeBoundary(refOf(pausedTask))).state,
      'paused',
    );

    const cancelHarness = createHarness();
    const cancelTask = start(cancelHarness);
    requireApplied(cancelHarness.coordinator.markAwaitingUserInput(refOf(cancelTask)));
    assert.equal(
      requireApplied(cancelHarness.coordinator.cancelTask(refOf(cancelTask))).state,
      'cancelled',
    );
  });

  it('allows paused to planning with a fresh generation and paused to cancelled', () => {
    const harness = createHarness();
    const task = start(harness);
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(task)));
    const resumed = requireApplied(harness.coordinator.resumeTask(refOf(task)));
    assert.equal(resumed.state, 'planning');
    assert.equal(resumed.generation, 2);
    assert.equal(harness.coordinator.getActiveTask()?.taskId, task.taskId);

    const cancelHarness = createHarness();
    const cancelTask = start(cancelHarness);
    requireApplied(cancelHarness.coordinator.pauseAtSafeBoundary(refOf(cancelTask)));
    assert.equal(
      requireApplied(cancelHarness.coordinator.cancelTask(refOf(cancelTask))).state,
      'cancelled',
    );
  });

  it('rejects every transition out of a terminal state', () => {
    const terminals: Array<(c: AutonomousTaskCoordinator, ref: AutonomousTaskRef) => AutonomousTaskMutationResult> = [
      (c, ref) => c.markCompleted(ref),
      (c, ref) => c.cancelTask(ref),
      (c, ref) => c.markBlocked(ref, 'POLICY_BLOCKED'),
      (c, ref) => c.markFailed(ref, 'PLANNER_FAILED'),
      (c, ref) => c.markExecutionStateUnknown(ref),
    ];
    for (const terminalize of terminals) {
      const harness = createHarness();
      const task = start(harness);
      const terminal = requireApplied(terminalize(harness.coordinator, refOf(task)));
      assertTaskError(
        () => harness.coordinator.beginChildRun(refOf(terminal)),
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
      );
      assertTaskError(
        () => harness.coordinator.pauseAtSafeBoundary(refOf(terminal)),
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
      );
      assertTaskError(
        () => harness.coordinator.resumeTask(refOf(terminal)),
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
      );
      assertTaskError(
        () => harness.coordinator.markCompleted(refOf(terminal)),
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
      );
    }
  });

  it('rejects matrix-illegal transitions without a generic backdoor', () => {
    const harness = createHarness();
    const task = start(harness);
    assertTaskError(
      () => harness.coordinator.markApprovalExecuted(refOf(task)),
      'AUTONOMOUS_TASK_INVALID_TRANSITION',
    );
    assertTaskError(
      () => harness.coordinator.recordApprovalPresented(refOf(task)),
      'AUTONOMOUS_TASK_INVALID_TRANSITION',
    );
    const paused = requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(task)));
    assertTaskError(
      () => harness.coordinator.beginChildRun(refOf(paused)),
      'AUTONOMOUS_TASK_INVALID_TRANSITION',
    );
  });

  it('releases tab ownership on terminalization and keeps the task record readable', () => {
    const harness = createHarness();
    const task = start(harness, 'tab-a');
    requireApplied(harness.coordinator.adoptTaskTab(refOf(task), 'tab-b', 'task-created'));
    const completed = requireApplied(harness.coordinator.markCompleted(refOf(task)));
    assert.equal(completed.state, 'completed');
    assert.equal(completed.terminalReason, 'COMPLETED');
    assert.equal(completed.ownedTabCount, 0);
    assert.equal(harness.coordinator.getActiveTask(), undefined);
    assert.equal(harness.coordinator.getOwnedTabs(task.taskId).length, 0);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'completed');
  });
});

describe('AutonomousTaskCoordinator generation and late refs', () => {
  it('increments generation on Resume and ignores stale generation mutations', () => {
    const harness = createHarness();
    const task = start(harness);
    const gen1 = refOf(task);
    requireApplied(harness.coordinator.pauseAtSafeBoundary(gen1));
    const resumed = requireApplied(harness.coordinator.resumeTask(gen1));
    assert.equal(resumed.generation, 2);
    assertIgnored(harness.coordinator.beginChildRun(gen1));
    assertIgnored(harness.coordinator.recordPlannerStepCompleted(gen1));
    assertIgnored(harness.coordinator.markCompleted(gen1));
    assertIgnored(harness.coordinator.adoptTaskTab(gen1, 'tab-x', 'task-created'));
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'planning');
    assert.equal(harness.coordinator.getTask(task.taskId)?.generation, 2);
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 0);
    assert.equal(harness.coordinator.inspectTask(gen1).status, 'superseded');
    assert.equal(harness.coordinator.isCurrentTask(gen1), false);

    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(resumed)));
    const third = requireApplied(harness.coordinator.resumeTask(refOf(resumed)));
    assert.equal(third.generation, 3);
    assertIgnored(harness.coordinator.beginChildRun(refOf(resumed)));
  });

  it('increments generation on user-input continuation and ignores the old ref', () => {
    const harness = createHarness();
    const task = start(harness);
    const waiting = requireApplied(harness.coordinator.markAwaitingUserInput(refOf(task)));
    const resumed = requireApplied(harness.coordinator.resumeFromUserInput(refOf(waiting)));
    assert.equal(resumed.generation, 2);
    assertIgnored(harness.coordinator.beginChildRun(refOf(waiting)));
    assert.equal(harness.coordinator.inspectTask(refOf(waiting)).status, 'superseded');
    assert.equal(harness.coordinator.getActiveTask()?.generation, 2);
  });
});

describe('AutonomousTaskCoordinator budgets', () => {
  it('blocks the ninth planner step at TASK_LIMIT_REACHED without counting past 8', () => {
    const harness = createHarness();
    const task = start(harness);
    const current = refOf(task);
    for (let step = 0; step < MAX_AUTONOMOUS_TASK_PLANNER_STEPS - 1; step += 1) {
      requireApplied(harness.coordinator.assertCanStartPlannerStep(current));
      requireApplied(harness.coordinator.recordPlannerStepCompleted(current));
    }
    const eighth = requireApplied(harness.coordinator.recordPlannerStepCompleted(current));
    assert.equal(eighth.plannerStepCount, 8);
    assert.equal(eighth.state, 'planning');
    const blocked = requireApplied(harness.coordinator.assertCanStartPlannerStep(current));
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(blocked.plannerStepCount, 8);
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 8);
  });

  it('blocks the fifth child run at TASK_LIMIT_REACHED without counting past 4', () => {
    const harness = createHarness();
    const task = start(harness);
    let current = refOf(task);
    for (let index = 0; index < MAX_AUTONOMOUS_TASK_CHILD_RUNS; index += 1) {
      requireApplied(harness.coordinator.assertCanStartChildRun(current));
      const completed = completeChild(harness, current);
      current = refOf(completed);
    }
    assert.equal(harness.coordinator.getTask(task.taskId)?.childRunCount, 4);
    const blocked = requireApplied(harness.coordinator.beginChildRun(current));
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(blocked.childRunCount, 4);
  });

  it('blocks the fifth approval presentation at TASK_LIMIT_REACHED without counting past 4', () => {
    const harness = createHarness();
    const task = start(harness);
    let current = refOf(requireApplied(harness.coordinator.beginChildRun(refOf(task))));
    for (let index = 0; index < MAX_AUTONOMOUS_TASK_APPROVALS; index += 1) {
      requireApplied(harness.coordinator.assertApprovalBudgetAvailable(current));
      const awaiting = requireApplied(harness.coordinator.recordApprovalPresented(current));
      current = refOf(requireApplied(harness.coordinator.markApprovalExecuted(refOf(awaiting))));
    }
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 4);
    const blocked = requireApplied(harness.coordinator.recordApprovalPresented(current));
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(blocked.taskApprovalCount, 4);
  });

  it('blocks a fourth concurrent owned tab at TASK_LIMIT_REACHED without registry mutation', () => {
    const harness = createHarness();
    const task = start(harness, 'tab-1');
    requireApplied(harness.coordinator.adoptTaskTab(refOf(task), 'tab-2', 'task-created'));
    requireApplied(harness.coordinator.adoptTaskTab(refOf(task), 'tab-3', 'task-created'));
    assert.equal(harness.coordinator.getOwnedTabs(task.taskId).length, MAX_AUTONOMOUS_TASK_OWNED_TABS);
    assert.equal(harness.coordinator.resolveTaskTabAlias(task.taskId, 'task-tab-3')?.tabId, 'tab-3');
    const blocked = requireApplied(
      harness.coordinator.adoptTaskTab(refOf(task), 'tab-4', 'task-created'),
    );
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(harness.coordinator.resolveTaskTabAlias(task.taskId, 'task-tab-4'), undefined);
    assert.equal(harness.coordinator.getOwnedTabs(task.taskId).length, 0);
  });
});

describe('AutonomousTaskCoordinator no-progress', () => {
  it('blocks an immediate repeated completed subgoal as TASK_NO_PROGRESS', () => {
    const harness = createHarness();
    const task = start(harness);
    const fingerprint = fingerprintSubgoal({
      taskTabAlias: 'task-tab-1',
      delegatedInstruction: 'Open settings',
      trustedTabStateToken: 'rev-1',
    });
    const running = requireApplied(harness.coordinator.beginChildRun(refOf(task)));
    requireApplied(harness.coordinator.recordCompletedSubgoalFingerprint(refOf(running), fingerprint));
    const planning = requireApplied(harness.coordinator.markChildCompleted(refOf(running)));
    const blocked = requireApplied(
      harness.coordinator.assertNoImmediateRepeatedSubgoal(refOf(planning), fingerprint),
    );
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.terminalReason, 'TASK_NO_PROGRESS');
    assert.equal(blocked.childRunCount, 1);
    assert.equal(JSON.stringify(harness.sink.getEvents()).includes(fingerprint), false);
    assert.equal(JSON.stringify(harness.sink.getEvents()).includes('Open settings'), false);
  });

  it('permits the same instruction after Resume or user-input continuation', () => {
    const fingerprint = fingerprintSubgoal({
      taskTabAlias: 'task-tab-1',
      delegatedInstruction: 'Open settings',
      trustedTabStateToken: 'rev-1',
    });
    const resumeHarness = createHarness();
    const resumeTask = start(resumeHarness);
    const running = requireApplied(resumeHarness.coordinator.beginChildRun(refOf(resumeTask)));
    requireApplied(
      resumeHarness.coordinator.recordCompletedSubgoalFingerprint(refOf(running), fingerprint),
    );
    requireApplied(resumeHarness.coordinator.markChildCompleted(refOf(running)));
    requireApplied(resumeHarness.coordinator.pauseAtSafeBoundary(refOf(resumeTask)));
    const resumed = requireApplied(resumeHarness.coordinator.resumeTask(refOf(resumeTask)));
    assert.equal(resumed.lastCompletedSubgoalFingerprint, undefined);
    const allowed = requireApplied(
      resumeHarness.coordinator.assertNoImmediateRepeatedSubgoal(refOf(resumed), fingerprint),
    );
    assert.equal(allowed.state, 'planning');

    const inputHarness = createHarness();
    const inputTask = start(inputHarness);
    const child = requireApplied(inputHarness.coordinator.beginChildRun(refOf(inputTask)));
    requireApplied(
      inputHarness.coordinator.recordCompletedSubgoalFingerprint(refOf(child), fingerprint),
    );
    requireApplied(inputHarness.coordinator.markChildCompleted(refOf(child)));
    requireApplied(inputHarness.coordinator.markAwaitingUserInput(refOf(inputTask)));
    const continued = requireApplied(inputHarness.coordinator.resumeFromUserInput(refOf(inputTask)));
    assert.equal(continued.lastCompletedSubgoalFingerprint, undefined);
    assert.equal(
      requireApplied(
        inputHarness.coordinator.assertNoImmediateRepeatedSubgoal(refOf(continued), fingerprint),
      ).state,
      'planning',
    );
  });
});

describe('AutonomousTaskCoordinator audit and dispose', () => {
  it('records started, planner, child, tab, approval, pause/resume, input, and terminal events', () => {
    const harness = createHarness();
    const task = start(harness, 'tab-1');
    const current = refOf(task);
    requireApplied(harness.coordinator.recordPlannerStepCompleted(current));
    requireApplied(harness.coordinator.beginChildRun(current));
    requireApplied(harness.coordinator.adoptTaskTab(current, 'tab-2', 'task-created'));
    requireApplied(harness.coordinator.recordApprovalPresented(current));
    requireApplied(harness.coordinator.markApprovalExecuted(current));
    requireApplied(harness.coordinator.markChildCompleted(current));
    requireApplied(harness.coordinator.markAwaitingUserInput(current));
    requireApplied(harness.coordinator.resumeFromUserInput(current));
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(harness.coordinator.getTask(task.taskId)!)));
    requireApplied(harness.coordinator.resumeTask(refOf(harness.coordinator.getTask(task.taskId)!)));
    requireApplied(harness.coordinator.releaseTaskTab(refOf(harness.coordinator.getTask(task.taskId)!), 'task-tab-2'));
    requireApplied(harness.coordinator.markBlocked(refOf(harness.coordinator.getTask(task.taskId)!), 'POLICY_BLOCKED'));

    const types = eventTypes(harness);
    for (const required of [
      'task-started',
      'planner-step-completed',
      'child-run-started',
      'child-run-completed',
      'task-tab-added',
      'task-tab-removed',
      'approval-presented',
      'task-paused',
      'task-resumed',
      'awaiting-user-input',
      'task-terminal',
    ]) {
      assert.equal(types.includes(required), true, `missing ${required}`);
    }
    const serialized = JSON.stringify(harness.sink.getEvents());
    assert.equal(serialized.includes('compare these three plans'), false);
    assert.equal(serialized.includes('objective'), false);
    assert.equal(serialized.includes('approvalId'), false);
    assert.equal(serialized.includes('targetId'), false);
  });

  it('keeps a newly installed task when start audit throws', () => {
    const sink: AutonomousTaskAuditSink = {
      append() {
        throw new Error('audit-down');
      },
      getEvents() {
        return Object.freeze([]);
      },
      clear() {},
    };
    const coordinator = new AutonomousTaskCoordinator({
      now: () => 1_000,
      generateTaskId: () => 'task-1',
      auditSink: sink,
    });
    const snapshot = coordinator.startTask('tab-1', 'keep planning');
    assert.equal(snapshot.state, 'planning');
    assert.equal(coordinator.getActiveTask()?.taskId, 'task-1');
    assert.equal(coordinator.getOwnedTabs('task-1').length, 1);
  });

  it('does not revive a terminal task when terminal audit throws', () => {
    const sink: AutonomousTaskAuditSink = {
      append() {
        throw new Error('audit-down');
      },
      getEvents() {
        return Object.freeze([]);
      },
      clear() {},
    };
    const coordinator = new AutonomousTaskCoordinator({
      now: () => 1_000,
      generateTaskId: () => 'task-1',
      auditSink: sink,
    });
    const snapshot = coordinator.startTask('tab-1', 'finish');
    const completed = requireApplied(coordinator.markCompleted(refOf(snapshot)));
    assert.equal(completed.state, 'completed');
    assert.equal(coordinator.getActiveTask(), undefined);
    assert.equal(coordinator.getTask(snapshot.taskId)?.state, 'completed');
    assert.equal(coordinator.getOwnedTabs(snapshot.taskId).length, 0);
  });

  it('dispose clears active, paused, and owned tabs so late refs are missing', () => {
    const harness = createHarness();
    const first = start(harness, 'tab-a');
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(first)));
    const second = start(harness, 'tab-b', 'active task');
    requireApplied(harness.coordinator.adoptTaskTab(refOf(second), 'tab-c', 'task-created'));
    const firstRef = refOf(first);
    const secondRef = refOf(second);
    harness.coordinator.dispose();
    assert.equal(harness.coordinator.getActiveTask(), undefined);
    assert.equal(harness.coordinator.getTask(first.taskId), undefined);
    assert.equal(harness.coordinator.getTask(second.taskId), undefined);
    assert.equal(harness.coordinator.inspectTask(firstRef).status, 'missing');
    assert.equal(harness.coordinator.inspectTask(secondRef).status, 'missing');
    assertIgnored(harness.coordinator.resumeTask(firstRef));
    assertIgnored(harness.coordinator.beginChildRun(secondRef));
    assert.equal(harness.coordinator.getOwnedTabs(first.taskId).length, 0);
    assert.equal(harness.coordinator.getOwnedTabs(second.taskId).length, 0);
  });
});

describe('AutonomousTaskCoordinator source isolation', () => {
  it('does not import browser adapters, agent-run, approval, model, Electron, React, or IPC', () => {
    const dir = path.join(__dirname);
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const forbidden = [
      'BrowserAdapter',
      'ElectronBrowserAdapter',
      'AgentRunCoordinator',
      'SafeAgentLoop',
      'AgentRunController',
      'InteractiveStepAgent',
      'InteractionExecutor',
      'ExecuteExecutor',
      'ApprovalManager',
      'PrepareActionService',
      'ModelRuntime',
      'ipcMain',
      "from 'electron'",
      'from "electron"',
      "from 'react'",
      'from "react"',
      'WebContents',
      'ConversationStore',
      'localStorage',
      'indexedDB',
      "from 'node:fs'",
      'setInterval',
    ];
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const needle of forbidden) {
        assert.equal(source.includes(needle), false, `${file} contains ${needle}`);
      }
    }
  });
});
