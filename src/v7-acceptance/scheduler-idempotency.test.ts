import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PersistentWorkflowRuntime } from '../main/persistent-workflow-runtime';
import { scheduledTriggerKey } from '../workflows/workflow-schedule';
import { FakeTimer, sampleWorkflow, withTempDirectory } from './runtime-helpers';

async function withClock(
  directory: string,
  session: string,
  nowIso: string,
  fn: (runtime: PersistentWorkflowRuntime, timer: FakeTimer) => Promise<void>,
): Promise<void> {
  let nowMs = Date.parse(nowIso);
  const timer = new FakeTimer();
  const runtime = await PersistentWorkflowRuntime.initialize({
    directory,
    runtimeSessionId: session,
    now: () => new Date(nowMs),
    timer,
  });
  try {
    await fn(runtime, timer);
  } finally {
    runtime.dispose();
  }
}

describe('V7 scheduler idempotency acceptance', () => {
  it('enqueues one occurrence per scheduled slot for one-time, daily, and weekly', async () => {
    await withTempDirectory(async (directory) => {
      await withClock(directory, 'sched-A', '2026-09-19T10:00:00.000Z', async (runtime) => {
        const oneTime = await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Once',
            trigger: { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: '2026-09-19T08:00:00.000Z' } },
          }),
        );
        const daily = await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Daily',
            trigger: {
              kind: 'schedule',
              schedule: { kind: 'recurring-daily', timeZone: 'UTC', hour: 8, minute: 0 },
            },
          }),
        );
        const weekly = await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Weekly',
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-weekly',
                timeZone: 'UTC',
                hour: 8,
                minute: 0,
                daysOfWeek: [6],
              },
            },
          }),
        );
        await runtime.flush();
        const queued = await runtime.getCoordinator()?.listQueuedOccurrences();
        assert.equal(queued?.length, 3);
        await runtime.notifyWorkflowStoreChanged();
        await runtime.flush();
        assert.equal((await runtime.getCoordinator()?.listQueuedOccurrences())?.length, 3);
        const keys = new Set(queued?.map((row) => row.triggerKey));
        assert.equal(keys.has(scheduledTriggerKey(oneTime.workflowId, '2026-09-19T08:00:00.000Z')), true);
        assert.equal(keys.has(scheduledTriggerKey(daily.workflowId, '2026-09-19T08:00:00.000Z')), true);
        assert.equal(keys.has(scheduledTriggerKey(weekly.workflowId, '2026-09-19T08:00:00.000Z')), true);
      });
    });
  });

  it('does not duplicate a scheduled slot after restart while it is still due', async () => {
    await withTempDirectory(async (directory) => {
      let occurrenceId = '';
      await withClock(directory, 'sched-A', '2026-09-19T10:00:00.000Z', async (runtime) => {
        await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Due',
            trigger: { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: '2026-09-19T08:00:00.000Z' } },
          }),
        );
        await runtime.flush();
        const queued = await runtime.getCoordinator()?.listQueuedOccurrences();
        assert.equal(queued?.length, 1);
        occurrenceId = queued![0]!.occurrenceId;
      });
      await withClock(directory, 'sched-B', '2026-09-19T10:00:00.000Z', async (runtime) => {
        await runtime.notifyWorkflowStoreChanged();
        await runtime.flush();
        const queued = await runtime.getCoordinator()?.listQueuedOccurrences();
        assert.equal(queued?.length, 1);
        assert.equal(queued?.[0]?.occurrenceId, occurrenceId);
      });
    });
  });

  it('preserves the scheduled dedupe anchor through real history compaction', async () => {
    await withTempDirectory(async (directory) => {
      await withClock(directory, 'compact-A', '2026-09-19T10:00:00.000Z', async (runtime) => {
        const created = await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Compact',
            trigger: { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: '2026-09-19T08:00:00.000Z' } },
          }),
        );
        await runtime.flush();
        const scheduled = (await runtime.getCoordinator()?.listQueuedOccurrences())?.[0];
        assert.ok(scheduled);
        await runtime.getCoordinator()?.markOccurrenceRunning(scheduled.occurrenceId);
        await runtime.getCoordinator()?.terminalizeRunningOccurrence({
          occurrenceId: scheduled.occurrenceId,
          state: 'completed',
          terminalReason: 'COMPLETED',
          finalAnswer: 'scheduled-done',
        });
        for (let index = 0; index < 51; index += 1) {
          const manual = await runtime.getCoordinator()?.enqueueManualOccurrence(created.workflowId);
          assert.ok(manual);
          await runtime.getCoordinator()?.markOccurrenceRunning(manual.occurrenceId);
          await runtime.getCoordinator()?.terminalizeRunningOccurrence({
            occurrenceId: manual.occurrenceId,
            state: 'completed',
            terminalReason: 'COMPLETED',
            finalAnswer: `manual-${index}`,
          });
        }
        const after = await runtime.getCoordinator()?.listOccurrences(created.workflowId);
        assert.equal(
          after?.some((row) => row.occurrenceId === scheduled.occurrenceId),
          true,
        );
      });
      await withClock(directory, 'compact-B', '2026-09-19T10:00:00.000Z', async (runtime) => {
        await runtime.notifyWorkflowStoreChanged();
        await runtime.flush();
        const queued = await runtime.getCoordinator()?.listQueuedOccurrences();
        assert.equal(queued?.length, 0);
        const all = await runtime.getCoordinator()?.listWorkflows();
        const occurrences = await runtime.getCoordinator()?.listOccurrences(all![0]!.workflowId);
        const scheduled = occurrences?.filter((row) => row.scheduledFor === '2026-09-19T08:00:00.000Z');
        assert.equal(scheduled?.length, 1);
      });
    });
  });

  it('coalesces missed recurring slots and does not fill historical holes', async () => {
    await withTempDirectory(async (directory) => {
      await withClock(directory, 'miss-A', '2026-09-24T10:00:00.000Z', async (runtime) => {
        const created = await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Daily',
            trigger: {
              kind: 'schedule',
              schedule: { kind: 'recurring-daily', timeZone: 'UTC', hour: 8, minute: 0 },
            },
          }),
        );
        await runtime.flush();
        const queued = await runtime.getCoordinator()?.listQueuedOccurrences();
        assert.equal(queued?.length, 1);
        assert.equal(queued?.[0]?.scheduledFor, '2026-09-24T08:00:00.000Z');
        await runtime.notifyWorkflowStoreChanged();
        await runtime.flush();
        assert.equal((await runtime.getCoordinator()?.listQueuedOccurrences())?.length, 1);
        await runtime.getCoordinator()?.markOccurrenceRunning(queued![0]!.occurrenceId);
        await runtime.getCoordinator()?.terminalizeRunningOccurrence({
          occurrenceId: queued![0]!.occurrenceId,
          state: 'completed',
          terminalReason: 'COMPLETED',
          finalAnswer: 'daily-done',
        });
      });
    });
    await withTempDirectory(async (directory) => {
      const timer = new FakeTimer();
      const runtime = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'hole-A',
        now: () => new Date('2026-09-20T10:00:00.000Z'),
        timer,
      });
      const created = await runtime.createWorkflow(
        sampleWorkflow({
          name: 'Hole',
          trigger: {
            kind: 'schedule',
            schedule: { kind: 'recurring-daily', timeZone: 'UTC', hour: 8, minute: 0 },
          },
        }),
      );
      await runtime.flush();
      const latest = (await runtime.getCoordinator()?.listQueuedOccurrences())?.[0];
      assert.equal(latest?.scheduledFor, '2026-09-20T08:00:00.000Z');
      runtime.dispose();

      const later = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'hole-B',
        now: () => new Date('2026-09-20T10:00:00.000Z'),
        timer: new FakeTimer(),
      });
      await later.notifyWorkflowStoreChanged();
      await later.flush();
      const queued = await later.getCoordinator()?.listQueuedOccurrences();
      assert.equal(queued?.length, 1);
      assert.equal(queued?.[0]?.occurrenceId, latest?.occurrenceId);
      assert.equal(queued?.[0]?.workflowId, created.workflowId);
      later.dispose();
    });
  });

  it('applies persisted DST semantics for Stockholm, New York, and Kathmandu', async () => {
    await withTempDirectory(async (directory) => {
      await withClock(directory, 'dst-gap', '2026-03-29T12:00:00.000Z', async (runtime) => {
        await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Stockholm gap',
            trigger: {
              kind: 'schedule',
              schedule: { kind: 'recurring-daily', timeZone: 'Europe/Stockholm', hour: 2, minute: 30 },
            },
          }),
        );
        await runtime.flush();
        assert.equal(
          (await runtime.getCoordinator()?.listQueuedOccurrences())?.[0]?.scheduledFor,
          '2026-03-28T01:30:00.000Z',
        );
      });
    });
    await withTempDirectory(async (directory) => {
      await withClock(directory, 'dst-overlap', '2026-10-25T12:00:00.000Z', async (runtime) => {
        await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Stockholm overlap',
            trigger: {
              kind: 'schedule',
              schedule: { kind: 'recurring-daily', timeZone: 'Europe/Stockholm', hour: 2, minute: 30 },
            },
          }),
        );
        await runtime.flush();
        assert.equal(
          (await runtime.getCoordinator()?.listQueuedOccurrences())?.[0]?.scheduledFor,
          '2026-10-25T00:30:00.000Z',
        );
      });
    });
    await withTempDirectory(async (directory) => {
      await withClock(directory, 'dst-ny', '2026-03-08T12:00:00.000Z', async (runtime) => {
        await runtime.createWorkflow(
          sampleWorkflow({
            name: 'New York gap',
            trigger: {
              kind: 'schedule',
              schedule: { kind: 'recurring-daily', timeZone: 'America/New_York', hour: 2, minute: 30 },
            },
          }),
        );
        await runtime.flush();
        const queued = await runtime.getCoordinator()?.listQueuedOccurrences();
        assert.equal(queued?.length, 1);
        assert.notEqual(queued?.[0]?.scheduledFor, '2026-03-08T07:30:00.000Z');
      });
    });
    await withTempDirectory(async (directory) => {
      await withClock(directory, 'ktm', '2026-09-19T10:00:00.000Z', async (runtime) => {
        await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Kathmandu',
            trigger: {
              kind: 'schedule',
              schedule: { kind: 'recurring-daily', timeZone: 'Asia/Kathmandu', hour: 9, minute: 0 },
            },
          }),
        );
        await runtime.flush();
        assert.equal(
          (await runtime.getCoordinator()?.listQueuedOccurrences())?.[0]?.scheduledFor,
          '2026-09-19T03:15:00.000Z',
        );
      });
    });
  });
});
