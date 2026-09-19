import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DurableWorkflowCoordinator } from './durable-workflow-coordinator';
import { WorkflowScheduler } from './workflow-scheduler';
import { AtomicJsonWorkflowStore } from './workflow-store';
import { DurableWorkflowError } from '../workflows/durable-workflow-errors';
import {
  MAX_SCHEDULER_TIMER_DELAY_MS,
  MIN_SCHEDULER_TIMER_DELAY_MS,
  type SchedulerTimerPort,
  type WorkflowSchedulerCoordinatorPort,
} from '../workflows/workflow-scheduler-types';
import { scheduledTriggerKey } from '../workflows/workflow-schedule';
import type { CreateDurableWorkflowInput } from '../workflows/durable-workflow-types';
import type {
  DurableWorkflowDefinitionRecord,
  WorkflowOccurrenceRecord,
  WorkflowTriggerRecord,
} from '../workflows/workflow-store-types';

const SAT_NOON_UTC = '2026-09-19T10:00:00.000Z';
const SAT_NINE_STOCKHOLM = '2026-09-19T07:00:00.000Z';
const SUN_NINE_STOCKHOLM = '2026-09-20T07:00:00.000Z';
const FRI_NINE_STOCKHOLM = '2026-09-18T07:00:00.000Z';

describe('WorkflowScheduler', () => {
  it('does not own execution, browser, model, or store-file authority', () => {
    const source = readFileSync(path.join(__dirname, 'workflow-scheduler.ts'), 'utf8');
    for (const banned of [
      'markOccurrenceRunning',
      'terminalizeRunningOccurrence',
      'BrowserAdapter',
      'AutonomousTaskController',
      'AgentRun',
      'ApprovalManager',
      'InteractionExecutor',
      'ExecuteExecutor',
      'electron',
      'workflows-v1.json',
      'readFile',
      'writeFile',
      'createTab',
      'navigate(',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
    assert.equal(MIN_SCHEDULER_TIMER_DELAY_MS, 1);
    assert.equal(MAX_SCHEDULER_TIMER_DELAY_MS, 2_147_483_647);
  });

  it('no-ops recompute and store-change notifications before start', async () => {
    const runAt = '2026-09-19T08:00:00.000Z';
    const harness = createScheduler({
      now: SAT_NOON_UTC,
      workflows: [definition('wf-1', oneTime(runAt))],
    });
    await harness.scheduler.recompute();
    await harness.scheduler.notifyStoreChanged();
    assert.equal(harness.coordinator.listCalls, 0);
    assert.equal(harness.coordinator.occurrenceListCalls, 0);
    assert.equal(harness.coordinator.scheduledEnqueues.length, 0);
    assert.equal(harness.coordinator.reviewMarks.length, 0);
    assert.equal(harness.timer.size, 0);

    await harness.scheduler.start();
    assert.deepEqual(harness.coordinator.scheduledEnqueues, [{ workflowId: 'wf-1', scheduledFor: runAt }]);
    assert.equal(harness.coordinator.listCalls, 1);
    assert.equal(harness.timer.size, 0);
  });

  it('ignores manual workflows', async () => {
    const { scheduler, coordinator, timer } = createScheduler({
      now: SAT_NOON_UTC,
      workflows: [definition('wf-manual', { kind: 'manual' })],
    });
    await scheduler.start();
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    assert.equal(coordinator.reviewMarks.length, 0);
    assert.equal(timer.size, 0);
  });

  it('does not enqueue a one-time schedule before it is due', async () => {
    const runAt = '2026-09-19T12:00:00.000Z';
    const { scheduler, coordinator, timer } = createScheduler({
      now: '2026-09-19T11:59:59.000Z',
      workflows: [definition('wf-1', oneTime(runAt))],
    });
    await scheduler.start();
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    assert.equal(timer.only.delayMs, Date.parse(runAt) - Date.parse('2026-09-19T11:59:59.000Z'));
  });

  it('enqueues a one-time schedule at the exact due instant and on overdue recompute', async () => {
    const runAt = '2026-09-19T12:00:00.000Z';
    const exact = createScheduler({
      now: runAt,
      workflows: [definition('wf-1', oneTime(runAt))],
    });
    await exact.scheduler.start();
    assert.deepEqual(exact.coordinator.scheduledEnqueues, [{ workflowId: 'wf-1', scheduledFor: runAt }]);
    assert.equal(exact.timer.size, 0);

    const overdue = createScheduler({
      now: '2026-09-19T13:00:00.000Z',
      workflows: [definition('wf-1', oneTime(runAt))],
    });
    await overdue.scheduler.start();
    assert.equal(overdue.coordinator.scheduledEnqueues.length, 1);
    await overdue.scheduler.recompute();
    assert.equal(overdue.coordinator.scheduledEnqueues.length, 1);
    assert.equal(overdue.coordinator.occurrences.length, 1);
  });

  it('coalesces five missed dailies to the latest due slot only', async () => {
    const { scheduler, coordinator } = createScheduler({
      now: SAT_NOON_UTC,
      workflows: [definition('wf-daily', dailyStockholm())],
    });
    await scheduler.start();
    assert.deepEqual(coordinator.scheduledEnqueues, [
      { workflowId: 'wf-daily', scheduledFor: SAT_NINE_STOCKHOLM },
    ]);
    assert.equal(coordinator.occurrences.length, 1);
  });

  it('does not backfill an older daily slot when the latest due already exists', async () => {
    const existing = scheduledOccurrence('wf-daily', SAT_NINE_STOCKHOLM);
    const { scheduler, coordinator, timer } = createScheduler({
      now: SAT_NOON_UTC,
      workflows: [definition('wf-daily', dailyStockholm())],
      occurrences: [existing],
    });
    await scheduler.start();
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    assert.equal(coordinator.occurrences.length, 1);
    assert.equal(timer.onlyDelayUntil(SUN_NINE_STOCKHOLM, SAT_NOON_UTC), true);
  });

  it('enqueues the previous daily slot when today is not yet due', async () => {
    const now = '2026-09-19T06:00:00.000Z';
    const { scheduler, coordinator, timer } = createScheduler({
      now,
      workflows: [definition('wf-daily', dailyStockholm())],
    });
    await scheduler.start();
    assert.deepEqual(coordinator.scheduledEnqueues, [
      { workflowId: 'wf-daily', scheduledFor: FRI_NINE_STOCKHOLM },
    ]);
    assert.equal(timer.onlyDelayUntil(SAT_NINE_STOCKHOLM, now), true);
  });

  it('enqueues a weekly Monday slot and respects ISO weekday midnight', async () => {
    const monday = createScheduler({
      now: '2026-09-21T10:00:00.000Z',
      workflows: [definition('wf-week', weeklyStockholm([1]))],
    });
    await monday.scheduler.start();
    assert.deepEqual(monday.coordinator.scheduledEnqueues, [
      { workflowId: 'wf-week', scheduledFor: '2026-09-21T07:00:00.000Z' },
    ]);

    const sunday = createScheduler({
      now: '2026-09-20T21:30:00.000Z',
      workflows: [definition('wf-week', weeklyStockholm([1]))],
    });
    await sunday.scheduler.start();
    assert.deepEqual(sunday.coordinator.scheduledEnqueues, [
      { workflowId: 'wf-week', scheduledFor: '2026-09-14T07:00:00.000Z' },
    ]);
  });

  it('evaluates multiple weekly weekdays without Sunday=0 leakage', async () => {
    const { scheduler, coordinator } = createScheduler({
      now: '2026-09-17T10:00:00.000Z',
      workflows: [definition('wf-week', weeklyStockholm([1, 5]))],
    });
    await scheduler.start();
    assert.deepEqual(coordinator.scheduledEnqueues, [
      { workflowId: 'wf-week', scheduledFor: '2026-09-14T07:00:00.000Z' },
    ]);
  });

  it('skips a Stockholm DST gap date and does not shift the local time', async () => {
    const { scheduler, coordinator } = createScheduler({
      now: '2026-03-29T12:00:00.000Z',
      workflows: [definition('wf-dst', daily('Europe/Stockholm', 2, 30))],
    });
    await scheduler.start();
    assert.deepEqual(coordinator.scheduledEnqueues, [
      { workflowId: 'wf-dst', scheduledFor: '2026-03-28T01:30:00.000Z' },
    ]);
  });

  it('selects the first Stockholm DST overlap occurrence', async () => {
    const { scheduler, coordinator } = createScheduler({
      now: '2026-10-25T12:00:00.000Z',
      workflows: [definition('wf-dst', daily('Europe/Stockholm', 2, 30))],
    });
    await scheduler.start();
    assert.deepEqual(coordinator.scheduledEnqueues, [
      { workflowId: 'wf-dst', scheduledFor: '2026-10-25T00:30:00.000Z' },
    ]);
  });

  it('fails closed on an unknown timezone without blocking a valid workflow', async () => {
    const { scheduler, coordinator } = createScheduler({
      now: SAT_NOON_UTC,
      workflows: [
        definition('wf-bad', daily('Mars/Olympus_Mons', 9, 0)),
        definition('wf-good', dailyStockholm()),
      ],
    });
    await scheduler.start();
    assert.deepEqual(coordinator.reviewMarks, ['wf-bad']);
    assert.equal(coordinator.workflow('wf-bad').reviewRequired, true);
    assert.deepEqual(coordinator.scheduledEnqueues, [
      { workflowId: 'wf-good', scheduledFor: SAT_NINE_STOCKHOLM },
    ]);
  });

  it('sets reviewRequired again after acknowledge if the timezone is still invalid', async () => {
    const harness = createScheduler({
      now: SAT_NOON_UTC,
      workflows: [definition('wf-bad', daily('Mars/Olympus_Mons', 9, 0))],
    });
    await harness.scheduler.start();
    harness.coordinator.workflows = [
      { ...harness.coordinator.workflow('wf-bad'), reviewRequired: false },
    ];
    await harness.scheduler.recompute();
    assert.deepEqual(harness.coordinator.reviewMarks, ['wf-bad', 'wf-bad']);
    assert.equal(harness.coordinator.workflow('wf-bad').reviewRequired, true);
    assert.equal(harness.coordinator.scheduledEnqueues.length, 0);
  });

  it('skips disabled and review-required workflows before timezone evaluation', async () => {
    const { scheduler, coordinator } = createScheduler({
      now: SAT_NOON_UTC,
      workflows: [
        definition('wf-disabled', daily('Mars/Olympus_Mons', 9, 0), { enabled: false }),
        definition('wf-review', dailyStockholm(), { reviewRequired: true }),
      ],
    });
    await scheduler.start();
    assert.equal(coordinator.reviewMarks.length, 0);
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    assert.equal(coordinator.listCalls, 1);
  });

  it('arms exactly one next-due timer for the earliest future workflow', async () => {
    const now = '2026-09-19T10:00:00.000Z';
    const later = '2026-09-19T14:00:00.000Z';
    const sooner = '2026-09-19T13:30:00.000Z';
    const { scheduler, timer } = createScheduler({
      now,
      workflows: [
        definition('wf-a', oneTime(later)),
        definition('wf-b', oneTime(sooner)),
        definition('wf-c', { kind: 'manual' }),
      ],
    });
    await scheduler.start();
    assert.equal(timer.size, 1);
    assert.equal(timer.only.delayMs, Date.parse(sooner) - Date.parse(now));
  });

  it('chunks delays longer than the signed 32-bit timer maximum', async () => {
    const now = '2026-09-19T10:00:00.000Z';
    const far = '2026-12-01T10:00:00.000Z';
    const { scheduler, timer } = createScheduler({
      now,
      workflows: [definition('wf-far', oneTime(far))],
    });
    await scheduler.start();
    assert.equal(timer.only.delayMs, MAX_SCHEDULER_TIMER_DELAY_MS);
  });

  it('ignores a stale timer callback after a newer recompute', async () => {
    const runAt = '2026-09-19T12:00:00.000Z';
    const clock = new Clock(nowMs('2026-09-19T11:00:00.000Z'));
    const { scheduler, coordinator, timer } = createScheduler({
      clock,
      workflows: [definition('wf-1', oneTime(runAt))],
    });
    await scheduler.start();
    const stale = timer.only.callback;
    clock.set('2026-09-19T13:00:00.000Z');
    await scheduler.recompute();
    assert.equal(coordinator.scheduledEnqueues.length, 1);
    await stale();
    assert.equal(coordinator.scheduledEnqueues.length, 1);
  });

  it('invalidates a timer after a schedule edit, disable, or delete', async () => {
    const t1 = '2026-09-19T12:00:00.000Z';
    const t2 = '2026-09-19T15:00:00.000Z';
    const now = '2026-09-19T11:00:00.000Z';
    const harness = createScheduler({
      now,
      workflows: [definition('wf-1', oneTime(t1))],
    });
    await harness.scheduler.start();
    const stale = harness.timer.only.callback;
    harness.coordinator.workflows = [definition('wf-1', oneTime(t2))];
    await harness.scheduler.notifyStoreChanged();
    assert.equal(harness.timer.only.delayMs, Date.parse(t2) - Date.parse(now));
    await stale();
    assert.equal(harness.coordinator.scheduledEnqueues.length, 0);

    harness.coordinator.workflows = [definition('wf-1', oneTime(t2), { enabled: false })];
    await harness.scheduler.recompute();
    assert.equal(harness.timer.size, 0);
    await stale();
    assert.equal(harness.coordinator.scheduledEnqueues.length, 0);

    harness.coordinator.workflows = [];
    await harness.scheduler.recompute();
    await stale();
    assert.equal(harness.coordinator.scheduledEnqueues.length, 0);
  });

  it('does not re-arm a timer from a start that finishes after dispose', async () => {
    const coordinator = new RecordingCoordinator([definition('wf-1', oneTime('2026-09-19T12:00:00.000Z'))]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = coordinator.listWorkflows.bind(coordinator);
    coordinator.listWorkflows = async () => {
      await gate;
      return original();
    };
    const timer = new FakeTimer();
    const scheduler = new WorkflowScheduler({
      coordinator,
      now: () => utc('2026-09-19T11:00:00.000Z'),
      timer,
    });
    const pending = scheduler.start();
    scheduler.dispose();
    release?.();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.message === 'Workflow scheduler is disposed.',
    );
    assert.equal(timer.size, 0);
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    await scheduler.recompute();
    await scheduler.notifyStoreChanged();
    assert.equal(timer.size, 0);
    await assert.rejects(
      () => scheduler.start(),
      (error: unknown) => error instanceof Error && error.message === 'Workflow scheduler is disposed.',
    );
    assert.equal(coordinator.scheduledEnqueues.length, 0);
  });

  it('serializes concurrent recomputes onto one enqueue', async () => {
    const coordinator = new RecordingCoordinator([definition('wf-1', oneTime('2026-09-19T10:00:00.000Z'))]);
    const scheduler = new WorkflowScheduler({
      coordinator,
      now: () => utc(SAT_NOON_UTC),
      timer: new FakeTimer(),
    });
    await scheduler.start();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = coordinator.listWorkflows.bind(coordinator);
    coordinator.listWorkflows = async () => {
      await gate;
      return original();
    };
    const first = scheduler.recompute();
    const second = scheduler.recompute();
    release?.();
    await Promise.all([first, second]);
    assert.equal(coordinator.scheduledEnqueues.length, 1);
  });

  it('calling start twice after success does not evaluate again', async () => {
    const { scheduler, coordinator, timer } = createScheduler({
      now: '2026-09-19T11:00:00.000Z',
      workflows: [definition('wf-1', oneTime('2026-09-19T12:00:00.000Z'))],
    });
    await scheduler.start();
    assert.equal(coordinator.listCalls, 1);
    await scheduler.start();
    assert.equal(coordinator.listCalls, 1);
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    assert.equal(timer.size, 1);
  });

  it('shares one in-flight start across concurrent callers', async () => {
    const coordinator = new RecordingCoordinator([
      definition('wf-1', oneTime('2026-09-19T10:00:00.000Z')),
    ]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = coordinator.listWorkflows.bind(coordinator);
    coordinator.listWorkflows = async () => {
      await gate;
      return original();
    };
    const timer = new FakeTimer();
    const scheduler = new WorkflowScheduler({
      coordinator,
      now: () => utc(SAT_NOON_UTC),
      timer,
    });
    const first = scheduler.start();
    const second = scheduler.start();
    release?.();
    await Promise.all([first, second]);
    assert.equal(coordinator.listCalls, 1);
    assert.equal(coordinator.scheduledEnqueues.length, 1);
    assert.equal(timer.size, 0);
  });

  it('contains timer-driven recompute failures without retrying', async () => {
    const testError = new DurableWorkflowError('WORKFLOW_NOT_INITIALIZED', 'timer-boom');
    const reported: unknown[] = [];
    let resolveReported: (() => void) | undefined;
    const reportedSeen = new Promise<void>((resolve) => {
      resolveReported = resolve;
    });
    const { scheduler, coordinator, timer } = createScheduler({
      now: '2026-09-19T11:00:00.000Z',
      workflows: [definition('wf-1', oneTime('2026-09-19T12:00:00.000Z'))],
      onBackgroundError: (error) => {
        reported.push(error);
        resolveReported?.();
      },
    });
    await scheduler.start();
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    assert.equal(timer.size, 1);
    let failedLists = 0;
    coordinator.listWorkflows = async () => {
      failedLists += 1;
      throw testError;
    };
    timer.invokeOnlyLikeTimeout();
    await reportedSeen;
    assert.deepEqual(reported, [testError]);
    assert.equal(failedLists, 1);
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    assert.equal(timer.size, 0);
  });

  it('contains a throwing background error handler', async () => {
    const testError = new DurableWorkflowError('WORKFLOW_NOT_INITIALIZED', 'timer-boom');
    let calls = 0;
    let resolveReported: (() => void) | undefined;
    const reportedSeen = new Promise<void>((resolve) => {
      resolveReported = resolve;
    });
    const { scheduler, coordinator, timer } = createScheduler({
      now: '2026-09-19T11:00:00.000Z',
      workflows: [definition('wf-1', oneTime('2026-09-19T12:00:00.000Z'))],
      onBackgroundError: () => {
        calls += 1;
        resolveReported?.();
        throw new Error('diagnostic failed');
      },
    });
    await scheduler.start();
    coordinator.listWorkflows = async () => {
      throw testError;
    };
    timer.invokeOnlyLikeTimeout();
    await reportedSeen;
    assert.equal(calls, 1);
    assert.equal(timer.size, 0);
  });

  it('still rejects explicit recompute after start when the coordinator fails', async () => {
    const testError = new DurableWorkflowError('WORKFLOW_NOT_INITIALIZED', 'explicit-boom');
    const reported: unknown[] = [];
    const { scheduler, coordinator } = createScheduler({
      now: '2026-09-19T11:00:00.000Z',
      workflows: [definition('wf-1', oneTime('2026-09-19T12:00:00.000Z'))],
      onBackgroundError: (error) => {
        reported.push(error);
      },
    });
    await scheduler.start();
    coordinator.listWorkflows = async () => {
      throw testError;
    };
    await assert.rejects(() => scheduler.recompute(), (error: unknown) => error === testError);
    await assert.rejects(() => scheduler.notifyStoreChanged(), (error: unknown) => error === testError);
    assert.equal(reported.length, 0);
  });

  it('enqueues the latest due after a forward clock jump and not a future slot on a backward jump', async () => {
    const clock = new Clock(nowMs('2026-09-19T06:59:00.000Z'));
    const { scheduler, coordinator, timer } = createScheduler({
      clock,
      workflows: [definition('wf-daily', dailyStockholm())],
    });
    await scheduler.start();
    assert.equal(coordinator.scheduledEnqueues[0]?.scheduledFor, FRI_NINE_STOCKHOLM);
    clock.set(SAT_NOON_UTC);
    await timer.fireOnly();
    assert.deepEqual(
      coordinator.scheduledEnqueues.map((item) => item.scheduledFor),
      [FRI_NINE_STOCKHOLM, SAT_NINE_STOCKHOLM],
    );
    assert.equal(timer.onlyDelayUntil(SUN_NINE_STOCKHOLM, SAT_NOON_UTC), true);

    clock.set('2026-09-19T06:00:00.000Z');
    const enqueues = coordinator.scheduledEnqueues.length;
    await timer.fireOnly();
    assert.equal(coordinator.scheduledEnqueues.length, enqueues);
  });

  it('rejects a failed start, stays inactive, then retries after the fault is fixed', async () => {
    const coordinator = new RecordingCoordinator([definition('wf-1', oneTime(SAT_NINE_STOCKHOLM))]);
    const boom = new DurableWorkflowError('WORKFLOW_NOT_INITIALIZED', 'boom');
    coordinator.listWorkflows = async () => {
      throw boom;
    };
    const timer = new FakeTimer();
    const scheduler = new WorkflowScheduler({
      coordinator,
      now: () => utc(SAT_NOON_UTC),
      timer,
    });
    await assert.rejects(
      () => scheduler.start(),
      (error: unknown) => error === boom,
    );
    assert.equal(timer.size, 0);
    assert.equal(coordinator.scheduledEnqueues.length, 0);

    const listsAfterFailure = coordinator.listCalls;
    await scheduler.recompute();
    await scheduler.notifyStoreChanged();
    assert.equal(coordinator.listCalls, listsAfterFailure);
    assert.equal(coordinator.scheduledEnqueues.length, 0);
    assert.equal(timer.size, 0);

    coordinator.listWorkflows = RecordingCoordinator.prototype.listWorkflows.bind(coordinator);
    await scheduler.start();
    assert.deepEqual(coordinator.scheduledEnqueues, [{ workflowId: 'wf-1', scheduledFor: SAT_NINE_STOCKHOLM }]);
  });

  it('enqueues a due one-time through a real store and keeps it after reload', async () => {
    await withTempDir(async (directory) => {
      const clock = new Clock(nowMs('2026-09-19T13:00:00.000Z'));
      const store = new AtomicJsonWorkflowStore({ directory });
      const coordinator = new DurableWorkflowCoordinator({ store, now: () => clock.now() });
      await coordinator.initialize('runtime-1');
      const workflow = await coordinator.createWorkflow(
        sampleInput({ trigger: oneTime('2026-09-19T12:00:00.000Z') }),
      );
      const timer = new FakeTimer();
      const scheduler = new WorkflowScheduler({
        coordinator,
        now: () => clock.now(),
        timer,
      });
      await scheduler.start();
      const occurrences = await coordinator.listOccurrences(workflow.workflowId);
      assert.equal(occurrences.length, 1);
      assert.equal(occurrences[0]?.scheduledFor, '2026-09-19T12:00:00.000Z');

      const reloaded = new DurableWorkflowCoordinator({
        store: new AtomicJsonWorkflowStore({ directory }),
        now: () => clock.now(),
      });
      await reloaded.initialize('runtime-2');
      const again = new WorkflowScheduler({
        coordinator: reloaded,
        now: () => clock.now(),
        timer: new FakeTimer(),
      });
      await again.start();
      assert.equal((await reloaded.listOccurrences(workflow.workflowId)).length, 1);
    });
  });

  it('does not duplicate a compacted one-time scheduled occurrence after restart', async () => {
    await withTempDir(async (directory) => {
      const clock = new Clock(nowMs('2026-09-19T12:00:00.000Z'));
      const store = new AtomicJsonWorkflowStore({ directory });
      const coordinator = new DurableWorkflowCoordinator({ store, now: () => clock.now() });
      await coordinator.initialize('runtime-1');
      const runAt = '2026-09-19T08:00:00.000Z';
      const workflow = await coordinator.createWorkflow(sampleInput({ trigger: oneTime(runAt) }));
      const scheduled = await coordinator.enqueueScheduledOccurrence({
        workflowId: workflow.workflowId,
        scheduledFor: runAt,
      });
      await completeRunning(coordinator, scheduled.occurrenceId);
      clock.advanceMs(1000);
      for (let index = 0; index < 51; index += 1) {
        const queued = await coordinator.enqueueManualOccurrence(workflow.workflowId);
        await completeRunning(coordinator, queued.occurrenceId);
        clock.advanceMs(1000);
      }
      const before = await coordinator.listOccurrences(workflow.workflowId);
      assert.equal(before.some((item) => item.occurrenceId === scheduled.occurrenceId), true);

      const reloaded = new DurableWorkflowCoordinator({
        store: new AtomicJsonWorkflowStore({ directory }),
        now: () => clock.now(),
      });
      await reloaded.initialize('runtime-2');
      const scheduler = new WorkflowScheduler({
        coordinator: reloaded,
        now: () => clock.now(),
        timer: new FakeTimer(),
      });
      await scheduler.start();
      const after = await reloaded.listOccurrences(workflow.workflowId);
      assert.equal(after.filter((item) => item.scheduledFor !== null).length, 1);
      assert.equal(after.some((item) => item.triggerKey === scheduledTriggerKey(workflow.workflowId, runAt)), true);
    });
  });

  it('does not backfill an older recurring slot after history compaction', async () => {
    await withTempDir(async (directory) => {
      const clock = new Clock(nowMs(SAT_NOON_UTC));
      const store = new AtomicJsonWorkflowStore({ directory });
      const coordinator = new DurableWorkflowCoordinator({ store, now: () => clock.now() });
      await coordinator.initialize('runtime-1');
      const workflow = await coordinator.createWorkflow(sampleInput({ trigger: dailyStockholm() }));
      const latest = await coordinator.enqueueScheduledOccurrence({
        workflowId: workflow.workflowId,
        scheduledFor: SAT_NINE_STOCKHOLM,
      });
      await completeRunning(coordinator, latest.occurrenceId);
      clock.advanceMs(1000);
      for (let index = 0; index < 51; index += 1) {
        const queued = await coordinator.enqueueManualOccurrence(workflow.workflowId);
        await completeRunning(coordinator, queued.occurrenceId);
        clock.advanceMs(1000);
      }
      const scheduler = new WorkflowScheduler({
        coordinator,
        now: () => clock.now(),
        timer: new FakeTimer(),
      });
      await scheduler.start();
      const scheduled = (await coordinator.listOccurrences(workflow.workflowId)).filter(
        (item) => item.scheduledFor !== null,
      );
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0]?.occurrenceId, latest.occurrenceId);
      assert.equal(scheduled[0]?.scheduledFor, SAT_NINE_STOCKHOLM);
    });
  });

  it('does not mutate an already-queued one-time occurrence after the definition is edited', async () => {
    await withTempDir(async (directory) => {
      const clock = new Clock(nowMs('2026-09-19T12:00:00.000Z'));
      const store = new AtomicJsonWorkflowStore({ directory });
      const coordinator = new DurableWorkflowCoordinator({ store, now: () => clock.now() });
      await coordinator.initialize('runtime-1');
      const workflow = await coordinator.createWorkflow(
        sampleInput({ trigger: oneTime('2026-09-19T11:00:00.000Z') }),
      );
      const first = await coordinator.enqueueScheduledOccurrence({
        workflowId: workflow.workflowId,
        scheduledFor: '2026-09-19T11:00:00.000Z',
      });
      await coordinator.editWorkflow(workflow.workflowId, {
        name: workflow.name,
        objective: workflow.objective,
        entryPoint: workflow.entryPoint,
        trigger: oneTime('2026-09-19T11:30:00.000Z'),
      });
      const scheduler = new WorkflowScheduler({
        coordinator,
        now: () => clock.now(),
        timer: new FakeTimer(),
      });
      await scheduler.start();
      const frozen = await coordinator.getOccurrence(first.occurrenceId);
      assert.equal(frozen?.definitionRevision, 1);
      assert.equal(frozen?.scheduledFor, '2026-09-19T11:00:00.000Z');
      const occurrences = await coordinator.listOccurrences(workflow.workflowId);
      assert.equal(occurrences.length, 2);
      assert.equal(
        occurrences.some((item) => item.scheduledFor === '2026-09-19T11:30:00.000Z' && item.definitionRevision === 2),
        true,
      );
    });
  });

  it('marks reviewRequired for an invalid persisted timezone in a real store', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      const coordinator = new DurableWorkflowCoordinator({ store });
      await coordinator.initialize('runtime-1');
      const workflow = await coordinator.createWorkflow(
        sampleInput({ trigger: daily('Mars/Olympus_Mons', 9, 0) }),
      );
      const other = await coordinator.createWorkflow(sampleInput({ trigger: dailyStockholm() }));
      const scheduler = new WorkflowScheduler({
        coordinator,
        now: () => utc(SAT_NOON_UTC),
        timer: new FakeTimer(),
      });
      await scheduler.start();
      assert.equal((await coordinator.getWorkflow(workflow.workflowId))?.reviewRequired, true);
      assert.equal((await coordinator.listOccurrences(workflow.workflowId)).length, 0);
      const good = await coordinator.listOccurrences(other.workflowId);
      assert.equal(good.length, 1);
      assert.equal(good[0]?.scheduledFor, SAT_NINE_STOCKHOLM);
    });
  });
});

function createScheduler(input: {
  now?: string;
  clock?: Clock;
  workflows: DurableWorkflowDefinitionRecord[];
  occurrences?: WorkflowOccurrenceRecord[];
  onBackgroundError?: (error: unknown) => void;
}): {
  scheduler: WorkflowScheduler;
  coordinator: RecordingCoordinator;
  timer: FakeTimer;
} {
  const coordinator = new RecordingCoordinator(input.workflows, input.occurrences ?? []);
  const timer = new FakeTimer();
  const clock = input.clock ?? new Clock(nowMs(input.now ?? SAT_NOON_UTC));
  const scheduler = new WorkflowScheduler({
    coordinator,
    now: () => clock.now(),
    timer,
    onBackgroundError: input.onBackgroundError,
  });
  return { scheduler, coordinator, timer };
}

class RecordingCoordinator implements WorkflowSchedulerCoordinatorPort {
  readonly scheduledEnqueues: { workflowId: string; scheduledFor: string }[] = [];
  readonly reviewMarks: string[] = [];
  listCalls = 0;
  occurrenceListCalls = 0;
  workflows: DurableWorkflowDefinitionRecord[];
  occurrences: WorkflowOccurrenceRecord[];

  constructor(
    workflows: DurableWorkflowDefinitionRecord[],
    occurrences: WorkflowOccurrenceRecord[] = [],
  ) {
    this.workflows = workflows.map((workflow) => ({ ...workflow }));
    this.occurrences = [...occurrences];
  }

  workflow(workflowId: string): DurableWorkflowDefinitionRecord {
    const found = this.workflows.find((item) => item.workflowId === workflowId);
    assert.ok(found);
    return found;
  }

  async listWorkflows(): Promise<readonly DurableWorkflowDefinitionRecord[]> {
    this.listCalls += 1;
    return this.workflows;
  }

  async listOccurrences(workflowId: string): Promise<readonly WorkflowOccurrenceRecord[]> {
    this.occurrenceListCalls += 1;
    return this.occurrences.filter((occurrence) => occurrence.workflowId === workflowId);
  }

  async enqueueScheduledOccurrence(input: {
    workflowId: string;
    scheduledFor: string;
  }): Promise<WorkflowOccurrenceRecord> {
    this.scheduledEnqueues.push({ ...input });
    const triggerKey = scheduledTriggerKey(input.workflowId, input.scheduledFor);
    const existing = this.occurrences.find((occurrence) => occurrence.triggerKey === triggerKey);
    if (existing) {
      return existing;
    }
    const record = scheduledOccurrence(input.workflowId, input.scheduledFor);
    this.occurrences.push(record);
    return record;
  }

  async markScheduleReviewRequired(workflowId: string): Promise<DurableWorkflowDefinitionRecord> {
    this.reviewMarks.push(workflowId);
    const workflow = this.workflow(workflowId);
    if (workflow.reviewRequired) {
      return workflow;
    }
    const updated = { ...workflow, reviewRequired: true };
    this.workflows = this.workflows.map((item) => (item.workflowId === workflowId ? updated : item));
    return updated;
  }
}

class FakeTimer implements SchedulerTimerPort {
  private nextId = 1;
  private readonly timers = new Map<number, { delayMs: number; callback: () => void | Promise<void> }>();

  get size(): number {
    return this.timers.size;
  }

  get only(): { delayMs: number; callback: () => void | Promise<void> } {
    assert.equal(this.timers.size, 1);
    return [...this.timers.values()][0]!;
  }

  onlyDelayUntil(iso: string, nowIso: string): boolean {
    return this.only.delayMs === Date.parse(iso) - Date.parse(nowIso);
  }

  setTimer(delayMs: number, callback: () => void | Promise<void>): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { delayMs, callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  async fireOnly(): Promise<void> {
    const id = [...this.timers.keys()][0];
    assert.ok(id !== undefined);
    const timer = this.timers.get(id);
    this.timers.delete(id);
    await timer?.callback();
  }

  invokeOnlyLikeTimeout(): void {
    void this.only.callback();
  }
}

class Clock {
  constructor(private current: number) {}

  now(): Date {
    return new Date(this.current);
  }

  set(iso: string): void {
    this.current = Date.parse(iso);
  }

  advanceMs(ms: number): void {
    this.current += ms;
  }
}

function definition(
  workflowId: string,
  trigger: WorkflowTriggerRecord,
  flags: { enabled?: boolean; reviewRequired?: boolean } = {},
): DurableWorkflowDefinitionRecord {
  return {
    workflowId,
    definitionRevision: 1,
    name: workflowId,
    objective: 'o',
    entryPoint: { kind: 'url', url: 'https://example.com/path' },
    trigger,
    enabled: flags.enabled ?? true,
    reviewRequired: flags.reviewRequired ?? false,
    createdAt: SAT_NOON_UTC,
    updatedAt: SAT_NOON_UTC,
  };
}

function scheduledOccurrence(workflowId: string, scheduledFor: string): WorkflowOccurrenceRecord {
  return {
    occurrenceId: `occ-${scheduledFor}`,
    workflowId,
    definitionRevision: 1,
    triggerKey: scheduledTriggerKey(workflowId, scheduledFor),
    scheduledFor,
    frozenDefinition: {
      objective: 'o',
      entryPoint: { kind: 'url', url: 'https://example.com/path' },
      trigger: { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: scheduledFor } },
    },
    state: 'completed',
    createdAt: scheduledFor,
    startedAt: scheduledFor,
    finishedAt: scheduledFor,
    ownerRuntimeSessionId: null,
    terminalReason: 'COMPLETED',
    finalAnswer: 'done',
  };
}

function oneTime(runAtUtc: string): WorkflowTriggerRecord {
  return { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc } };
}

function daily(timeZone: string, hour: number, minute: number): WorkflowTriggerRecord {
  return { kind: 'schedule', schedule: { kind: 'recurring-daily', timeZone, hour, minute } };
}

function dailyStockholm(): WorkflowTriggerRecord {
  return daily('Europe/Stockholm', 9, 0);
}

function weeklyStockholm(daysOfWeek: readonly number[]): WorkflowTriggerRecord {
  return {
    kind: 'schedule',
    schedule: { kind: 'recurring-weekly', timeZone: 'Europe/Stockholm', hour: 9, minute: 0, daysOfWeek },
  };
}

function sampleInput(
  overrides: { trigger?: WorkflowTriggerRecord } = {},
): CreateDurableWorkflowInput {
  return {
    name: 'Invoice check',
    objective: 'Open the invoice page and summarize totals.',
    entryPoint: { kind: 'url', url: 'https://example.com/path?resource=123' },
    trigger: overrides.trigger ?? { kind: 'manual' },
  };
}

async function completeRunning(
  coordinator: DurableWorkflowCoordinator,
  occurrenceId: string,
): Promise<void> {
  await coordinator.markOccurrenceRunning(occurrenceId);
  await coordinator.terminalizeRunningOccurrence({
    occurrenceId,
    state: 'completed',
    finalAnswer: 'done',
  });
}

function utc(iso: string): Date {
  return new Date(iso);
}

function nowMs(iso: string): number {
  return Date.parse(iso);
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-sched-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
