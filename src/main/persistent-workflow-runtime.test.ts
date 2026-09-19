import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PersistentWorkflowRuntime } from './persistent-workflow-runtime';
import { AtomicJsonWorkflowStore, WORKFLOW_STORE_CANONICAL_FILENAME } from './workflow-store';
import { DurableWorkflowError } from '../workflows/durable-workflow-errors';
import type {
  CreateDurableWorkflowInput,
  WorkflowStorePort,
} from '../workflows/durable-workflow-types';
import { WorkflowStoreError } from '../workflows/workflow-store-errors';
import type { SchedulerTimerPort } from '../workflows/workflow-scheduler-types';
import type {
  WorkflowStoreMutation,
  WorkflowStoreSnapshot,
} from '../workflows/workflow-store-types';
import type {
  AutonomousTaskControlResult,
  AutonomousTaskEvent,
  AutonomousTaskStartResult,
  AutonomousTaskView,
} from '../shared/autonomous-task-types';
import type { TabId } from '../shared/browser-types';
import type { WorkflowExecutionTaskPort } from './persistent-workflow-runtime';
import { WORKFLOW_START_REASON } from '../workflows/workflow-occurrence-runner-types';

const BASE_TIME = Date.parse('2026-09-19T10:00:00.000Z');
const VIEW_LIMITS = {
  plannerSteps: 8,
  childRuns: 4,
  ownedTabs: 3,
  approvals: 4,
} as const;

describe('PersistentWorkflowRuntime', () => {
  it('recovers a foreign-session running occurrence before any drain', async () => {
    await withDirectory(async (directory) => {
      const first = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-A',
        now: () => new Date(BASE_TIME),
        timer: new FakeTimer(),
      });
      const { occurrence } = await enqueue(first, { name: 'Recover me' });
      const browser = new FakeBrowser();
      const tasks = new FakeTasks();
      first.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await first.flush();
      assert.equal((await first.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      first.dispose();

      const second = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-B',
        now: () => new Date(BASE_TIME + 1000),
        timer: new FakeTimer(),
      });
      const recovered = await second.getCoordinator()?.getOccurrence(occurrence.occurrenceId);
      assert.equal(recovered?.state, 'interrupted');
      assert.equal((await second.getCoordinator()?.getWorkflow(occurrence.workflowId))?.reviewRequired, true);
      const browserB = new FakeBrowser();
      const tasksB = new FakeTasks();
      second.attachExecutionRuntime({ browser: browserB, autonomousTasks: tasksB });
      await second.flush();
      assert.equal(browserB.created.length, 0);
      assert.equal(tasksB.trustedStarts.length, 0);
      second.dispose();
    });
  });

  it('starts a persisted queued occurrence after restart without duplicating it', async () => {
    await withDirectory(async (directory) => {
      const first = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-A',
        now: () => new Date(BASE_TIME),
        timer: new FakeTimer(),
      });
      const { occurrence } = await enqueue(first);
      first.dispose();

      const second = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-B',
        now: () => new Date(BASE_TIME + 1000),
        timer: new FakeTimer(),
      });
      const queued = await second.getCoordinator()?.getOccurrence(occurrence.occurrenceId);
      assert.equal(queued?.state, 'queued');
      const browser = new FakeBrowser();
      const tasks = new FakeTasks();
      second.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await second.flush();
      assert.equal((await second.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      assert.equal(browser.created.length, 1);
      assert.equal(tasks.trustedStarts.length, 1);
      const listed = await second.getCoordinator()?.listQueuedOccurrences();
      assert.equal(listed?.some((item) => item.occurrenceId === occurrence.occurrenceId), false);
      second.dispose();
    });
  });

  it('rejects manual Delegate while workflow durable claim is pending', async () => {
    await withRuntime(async ({ runtime }) => {
      const { occurrence } = await enqueue(runtime);
      const hold = new Deferred<void>();
      runtime.setMarkRunningGate(() => hold.promise);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await waitUntil(() => runtime.getSlotOwner()?.kind === 'workflow', 'workflow reserved');
      const manual = runtime.startManualAutonomousTask('Do it now');
      assert.equal(manual.ok, false);
      assert.equal(tasks.manualStarts.length, 0);
      hold.resolve();
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      assert.equal(tasks.trustedStarts.length, 1);
    });
  });

  it('keeps a queued occurrence queued while manual Delegate owns the slot', async () => {
    await withRuntime(async ({ runtime }) => {
      const { occurrence } = await enqueue(runtime);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const manual = runtime.startManualAutonomousTask('Hold the slot');
      assert.equal(manual.ok, true);
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'queued');
      assert.equal(browser.created.length, 0);
      if (!manual.ok) {
        throw new Error('expected manual start');
      }
      tasks.complete(manual.task.taskId, 'Done.');
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      assert.equal(tasks.trustedStarts.length, 1);
    });
  });

  it('rejects Resume of a paused manual task while workflow claim is pending', async () => {
    await withRuntime(async ({ runtime }) => {
      const { occurrence } = await enqueue(runtime);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const started = runtime.startManualAutonomousTask('Pause me');
      assert.equal(started.ok, true);
      if (!started.ok) {
        throw new Error('expected start');
      }
      const hold = new Deferred<void>();
      runtime.setMarkRunningGate(() => hold.promise);
      await runtime.pauseAutonomousTask(started.task.taskId);
      assert.equal(runtime.getSlotOwner(), undefined);
      await waitUntil(() => runtime.getSlotOwner()?.kind === 'workflow', 'workflow reserved');
      const resumed = runtime.resumeManualAutonomousTask(started.task.taskId);
      assert.equal(resumed.ok, false);
      assert.equal(tasks.resumes.length, 0);
      hold.resolve();
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    });
  });

  it('blocks manual Delegate while a workflow task is awaiting approval or paused', async () => {
    await withRuntime(async ({ runtime }) => {
      await enqueue(runtime);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      const taskId = tasks.trustedStarts[0]?.taskId;
      assert.ok(taskId);
      tasks.emitAwaitingApproval(taskId);
      await runtime.flush();
      assert.equal(runtime.startManualAutonomousTask('Interrupt').ok, false);
      tasks.emitPaused(taskId);
      await runtime.flush();
      assert.equal(runtime.startManualAutonomousTask('Interrupt paused').ok, false);
      assert.equal(runtime.getSlotOwner()?.kind, 'workflow');
    });
  });

  it('starts FIFO A then B after a manual Delegate ends, skipping disabled and review-required rows', async () => {
    await withRuntime(async ({ runtime }) => {
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const started = runtime.startManualAutonomousTask('Busy first');
      assert.equal(started.ok, true);
      const disabled = await enqueue(runtime, { name: 'Disabled' });
      const review = await enqueue(runtime, { name: 'Review' });
      const first = await enqueue(runtime, { name: 'First eligible', objective: 'A' });
      const second = await enqueue(runtime, { name: 'Second eligible', objective: 'B' });
      await runtime.getCoordinator()?.setEnabled(disabled.workflow.workflowId, false);
      await runtime.getCoordinator()?.markScheduleReviewRequired(review.workflow.workflowId);
      if (!started.ok) {
        throw new Error('expected manual');
      }
      tasks.complete(started.task.taskId, 'Manual done.');
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(first.occurrence.occurrenceId))?.state, 'running');
      assert.equal((await runtime.getCoordinator()?.getOccurrence(second.occurrence.occurrenceId))?.state, 'queued');
      assert.equal((await runtime.getCoordinator()?.getOccurrence(disabled.occurrence.occurrenceId))?.state, 'queued');
      assert.equal((await runtime.getCoordinator()?.getOccurrence(review.occurrence.occurrenceId))?.state, 'queued');
      const live = runtime.getRunner()?.inspectLiveExecution();
      assert.ok(live);
      tasks.complete(live.taskId, 'A done.');
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(second.occurrence.occurrenceId))?.state, 'running');
      assert.equal(tasks.trustedStarts.length, 2);
    });
  });

  it('keeps FIFO blocked while startup terminal bookkeeping is pending', async () => {
    await withRuntime(async ({ runtime }) => {
      const first = await enqueue(runtime, { name: 'A' });
      const second = await enqueue(runtime, { name: 'B', objective: 'Later' });
      const browser = new FakeBrowser();
      browser.failCreate = new Error('no tab');
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.setTerminalizeGate(async () => {
        throw new Error('persist failed');
      });
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(first.occurrence.occurrenceId))?.state, 'running');
      assert.equal(runtime.getRunner()?.inspectLiveExecution(), undefined);
      assert.equal(runtime.getSlotOwner()?.kind, 'workflow');
      assert.equal(runtime.startManualAutonomousTask('No').ok, false);
      assert.equal((await runtime.getCoordinator()?.getOccurrence(second.occurrence.occurrenceId))?.state, 'queued');
      runtime.setTerminalizeGate(undefined);
      browser.failCreate = undefined;
      await runtime.stopActiveWorkflowOccurrence();
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(first.occurrence.occurrenceId))?.state, 'failed');
      assert.equal((await runtime.getCoordinator()?.getOccurrence(first.occurrence.occurrenceId))?.terminalReason, WORKFLOW_START_REASON.TAB);
      assert.equal((await runtime.getCoordinator()?.getOccurrence(second.occurrence.occurrenceId))?.state, 'running');
    });
  });

  it('keeps FIFO blocked while live terminal bookkeeping is pending', async () => {
    await withRuntime(async ({ runtime }) => {
      const first = await enqueue(runtime, { name: 'A' });
      const second = await enqueue(runtime, { name: 'B', objective: 'Later' });
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      const live = runtime.getRunner()?.inspectLiveExecution();
      assert.ok(live);
      runtime.setTerminalizeGate(async () => {
        throw new Error('persist failed');
      });
      tasks.complete(live.taskId, 'A done.');
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(first.occurrence.occurrenceId))?.state, 'running');
      assert.equal(runtime.getSlotOwner()?.kind, 'workflow');
      assert.equal(runtime.startManualAutonomousTask('No').ok, false);
      assert.equal((await runtime.getCoordinator()?.getOccurrence(second.occurrence.occurrenceId))?.state, 'queued');
      runtime.setTerminalizeGate(undefined);
      await runtime.stopActiveWorkflowOccurrence();
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(first.occurrence.occurrenceId))?.state, 'completed');
      assert.equal((await runtime.getCoordinator()?.getOccurrence(second.occurrence.occurrenceId))?.state, 'running');
    });
  });

  it('enqueues due scheduled work without execution, then drains on attach', async () => {
    await withDirectory(async (directory) => {
      const timer = new FakeTimer();
      const runtime = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-sched',
        now: () => new Date(BASE_TIME),
        timer,
      });
      await runtime.getCoordinator()?.createWorkflow({
        name: 'Due',
        objective: 'Scheduled research',
        entryPoint: { kind: 'url', url: 'https://example.test/due' },
        trigger: { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: '2026-09-19T08:00:00.000Z' } },
      });
      await runtime.notifyWorkflowStoreChanged();
      await runtime.flush();
      const queued = await runtime.getCoordinator()?.listQueuedOccurrences();
      assert.equal(queued?.length, 1);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks();
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      assert.equal(browser.created.length, 1);
      assert.equal(browser.created[0]?.url, 'https://example.test/due');
      assert.equal(tasks.trustedStarts[0]?.objective, 'Scheduled research');
      runtime.dispose();
    });
  });

  it('cancels a queued occurrence without V6 work and drains the next row', async () => {
    await withRuntime(async ({ runtime }) => {
      const first = await enqueue(runtime, { name: 'Cancel me' });
      const second = await enqueue(runtime, { name: 'Keep me', objective: 'Next' });
      await runtime.cancelQueuedOccurrence(first.occurrence.occurrenceId);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks();
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(first.occurrence.occurrenceId))?.state, 'cancelled');
      assert.equal((await runtime.getCoordinator()?.getOccurrence(second.occurrence.occurrenceId))?.state, 'running');
      assert.equal(tasks.trustedStarts.length, 1);
    });
  });

  it('stops a live workflow through V6 and rejects delete while running', async () => {
    await withRuntime(async ({ runtime }) => {
      const { workflow, occurrence } = await enqueue(runtime);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      await assert.rejects(
        () => runtime.deleteWorkflow(workflow.workflowId),
        (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_RUNNING',
      );
      await runtime.stopActiveWorkflowOccurrence();
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'blocked');
      await runtime.deleteWorkflow(workflow.workflowId);
      assert.equal(await runtime.getCoordinator()?.getWorkflow(workflow.workflowId), undefined);
    });
  });

  it('fails closed on store corruption without resetting files or blocking manual V6', async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME);
      await fs.writeFile(filePath, '{not-json', 'utf8');
      const runtime = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-corrupt',
        timer: new FakeTimer(),
      });
      assert.equal(runtime.status, 'storage-error');
      const after = await fs.readFile(filePath, 'utf8');
      assert.equal(after, '{not-json');
      const browser = new FakeBrowser();
      const tasks = new FakeTasks();
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const manual = runtime.startManualAutonomousTask('Still works');
      assert.equal(manual.ok, true);
      assert.equal(browser.created.length, 0);
      runtime.dispose();
    });
  });

  it('contains a recovery-commit WorkflowStoreError without starting the scheduler', async () => {
    await withDirectory(async (directory) => {
      const first = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-A',
        now: () => new Date(BASE_TIME),
        timer: new FakeTimer(),
      });
      const { occurrence } = await enqueue(first, { name: 'Recover me' });
      first.attachExecutionRuntime({ browser: new FakeBrowser(), autonomousTasks: new FakeTasks() });
      await first.flush();
      assert.equal((await first.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      first.dispose();

      const inner = new AtomicJsonWorkflowStore({ directory });
      const store = new CommitFailingStore(inner);
      store.failNextCommit(
        new WorkflowStoreError('WORKFLOW_STORE_IO_FAILED', 'Workflow store I/O failed.'),
      );
      const timer = new FakeTimer();
      const second = await PersistentWorkflowRuntime.initialize({
        directory,
        store,
        runtimeSessionId: 'runtime-B',
        now: () => new Date(BASE_TIME + 1000),
        timer,
      });
      assert.equal(second.status, 'storage-error');
      assert.equal(second.getCoordinator(), undefined);
      assert.equal(second.getRunner(), undefined);
      assert.equal(timer.size, 0);
      const persisted = (await inner.load()).occurrences.find(
        (item) => item.occurrenceId === occurrence.occurrenceId,
      );
      assert.equal(persisted?.state, 'running');
      await assertManualUsableWithoutWorkflow(second);
      second.dispose();
    });
  });

  it('contains a scheduler-start WorkflowStoreError and disposes any timer', async () => {
    await withDirectory(async (directory) => {
      const first = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-sched-a',
        now: () => new Date(BASE_TIME),
        timer: new FakeTimer(),
      });
      await first.getCoordinator()?.createWorkflow({
        name: 'Due',
        objective: 'Scheduled research',
        entryPoint: { kind: 'url', url: 'https://example.test/due' },
        trigger: { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: '2026-09-19T08:00:00.000Z' } },
      });
      first.dispose();

      const inner = new AtomicJsonWorkflowStore({ directory });
      const store = new CommitFailingStore(inner);
      store.failNextCommit(
        new WorkflowStoreError('WORKFLOW_STORE_IO_FAILED', 'Workflow store I/O failed.'),
      );
      const timer = new FakeTimer();
      const second = await PersistentWorkflowRuntime.initialize({
        directory,
        store,
        runtimeSessionId: 'runtime-sched-b',
        now: () => new Date(BASE_TIME),
        timer,
      });
      assert.equal(second.status, 'storage-error');
      assert.equal(second.getCoordinator(), undefined);
      assert.equal(second.getRunner(), undefined);
      assert.equal(timer.size, 0);
      assert.equal((await inner.load()).occurrences.length, 0);
      await assertManualUsableWithoutWorkflow(second);
      second.dispose();
    });
  });

  it('rejects initialization for unexpected non-storage errors', async () => {
    await withDirectory(async (directory) => {
      const store: WorkflowStorePort = {
        async load(): Promise<WorkflowStoreSnapshot> {
          throw new Error('programmer failure');
        },
        async commit(): Promise<WorkflowStoreSnapshot> {
          throw new Error('commit should not run');
        },
      };
      await assert.rejects(
        () =>
          PersistentWorkflowRuntime.initialize({
            directory,
            store,
            runtimeSessionId: 'runtime-bug',
            timer: new FakeTimer(),
          }),
        (error: unknown) => error instanceof Error && error.message === 'programmer failure',
      );
    });
  });

  it('ignores stale scheduler callbacks and events after shutdown', async () => {
    await withDirectory(async (directory) => {
      const timer = new FakeTimer();
      const runtime = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-stop',
        now: () => new Date(BASE_TIME),
        timer,
      });
      await runtime.getCoordinator()?.createWorkflow({
        name: 'Future',
        objective: 'Later',
        entryPoint: { kind: 'url', url: 'https://example.test/later' },
        trigger: {
          kind: 'schedule',
          schedule: { kind: 'one-time', runAtUtc: '2026-09-19T12:00:00.000Z' },
        },
      });
      await runtime.notifyWorkflowStoreChanged();
      const callback = timer.size === 1 ? timer.only.callback : undefined;
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      runtime.beginShutdown();
      runtime.dispose();
      if (callback) {
        await callback();
      }
      runtime.handleAutonomousTaskEvent({
        type: 'autonomous-task-completed',
        task: taskView('task-stale', 'completed', { terminalReason: 'COMPLETED', completedAnswer: 'no' }),
      });
      await runtime.flush();
      assert.equal(browser.created.length, 0);
      assert.equal(tasks.trustedStarts.length, 0);
    });
  });

  it('unsubscribes on detach so reattach does not duplicate workflow event handling', async () => {
    await withRuntime(async ({ runtime }) => {
      await enqueue(runtime);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks();
      const listeners = new Set<(event: AutonomousTaskEvent) => void>();
      const subscribe = (listener: (event: AutonomousTaskEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks }, subscribe);
      await runtime.flush();
      runtime.detachExecutionRuntime();
      await runtime.flush();
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks }, subscribe);
      await runtime.flush();
      assert.equal(listeners.size, 1);
    });
  });

  it('releases an active manual slot when execution runtime detaches', async () => {
    await withRuntime(async ({ runtime }) => {
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const started = runtime.startManualAutonomousTask('Keep going');
      assert.equal(started.ok, true);
      if (!started.ok) {
        throw new Error('expected manual');
      }
      assert.equal(runtime.getSlotOwner()?.kind, 'manual');
      runtime.detachExecutionRuntime();
      assert.equal(runtime.getSlotOwner(), undefined);
      assert.equal(browser.created.length, 0);
    });
  });

  it('starts a queued workflow after a detached manual Delegate is gone', async () => {
    await withRuntime(async ({ runtime }) => {
      const { occurrence } = await enqueue(runtime);
      const browserA = new FakeBrowser();
      const tasksA = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser: browserA, autonomousTasks: tasksA });
      const started = runtime.startManualAutonomousTask('Hold then close');
      assert.equal(started.ok, true);
      runtime.detachExecutionRuntime();
      await runtime.flush();
      assert.equal(runtime.getSlotOwner(), undefined);
      assert.equal(browserA.created.length, 0);
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state,
        'queued',
      );
      const browserB = new FakeBrowser();
      const tasksB = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser: browserB, autonomousTasks: tasksB });
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      assert.equal(browserB.created.length, 1);
      assert.equal(tasksB.trustedStarts.length, 1);
      assert.equal(runtime.getSlotOwner()?.kind, 'workflow');
    });
  });

  it('does not let a stale detach clear a freshly attached runner', async () => {
    await withRuntime(async ({ runtime }) => {
      const { occurrence } = await enqueue(runtime);
      const listeners = new Set<(event: AutonomousTaskEvent) => void>();
      const subscribe = (listener: (event: AutonomousTaskEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const browserA = new FakeBrowser();
      const tasksA = new FakeTasks();
      const browserB = new FakeBrowser();
      const tasksB = new FakeTasks();
      runtime.attachExecutionRuntime({ browser: browserA, autonomousTasks: tasksA }, subscribe);
      runtime.detachExecutionRuntime();
      runtime.attachExecutionRuntime({ browser: browserB, autonomousTasks: tasksB }, subscribe);
      await runtime.flush();
      assert.equal(listeners.size, 1);
      assert.ok(runtime.getRunner());
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      assert.equal(browserA.created.length, 0);
      assert.equal(tasksA.trustedStarts.length, 0);
      assert.equal(browserB.created.length, 1);
      assert.equal(tasksB.trustedStarts.length, 1);
    });
  });

  it('maps an active workflow detach to unknown before a new runner can drain', async () => {
    await withRuntime(async ({ runtime }) => {
      const { occurrence, workflow } = await enqueue(runtime);
      const browserA = new FakeBrowser();
      const tasksA = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser: browserA, autonomousTasks: tasksA });
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      const browserB = new FakeBrowser();
      const tasksB = new FakeTasks();
      runtime.detachExecutionRuntime();
      runtime.attachExecutionRuntime({ browser: browserB, autonomousTasks: tasksB });
      await runtime.flush();
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state,
        'execution-state-unknown',
      );
      assert.equal((await runtime.getCoordinator()?.getWorkflow(workflow.workflowId))?.reviewRequired, true);
      assert.equal(tasksB.trustedStarts.length, 0);
      assert.equal(browserB.created.length, 0);
    });
  });

  it('disables automatic workflow execution when detach terminal persistence fails', async () => {
    await withRuntime(async ({ runtime }) => {
      await enqueue(runtime);
      const browserA = new FakeBrowser();
      const tasksA = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser: browserA, autonomousTasks: tasksA });
      await runtime.flush();
      runtime.setTerminalizeGate(async () => {
        throw new WorkflowStoreError('WORKFLOW_STORE_IO_FAILED', 'Workflow store I/O failed.');
      });
      const browserB = new FakeBrowser();
      const tasksB = new FakeTasks();
      runtime.detachExecutionRuntime();
      runtime.attachExecutionRuntime({ browser: browserB, autonomousTasks: tasksB });
      await runtime.flush();
      assert.equal(runtime.getRunner()?.getActiveOccurrence() !== undefined, true);
      assert.equal(tasksB.trustedStarts.length, 0);
      assert.equal(browserB.created.length, 0);
    });
  });
});

describe('V7 Phase 5 architecture', () => {
  it('acquires the single-instance lock before primary workflow initialization', () => {
    const main = readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    const lock = main.indexOf('app.requestSingleInstanceLock()');
    const init = main.indexOf('await initializePersistentWorkflowRuntime');
    const quit = main.indexOf('app.quit()');
    const loser = main.slice(main.indexOf('if (!isPrimaryInstance)'), main.indexOf('} else {'));
    assert.ok(lock >= 0);
    assert.ok(init > lock);
    assert.ok(quit > lock);
    assert.ok(quit < init);
    assert.equal(loser.includes('initializePersistentWorkflowRuntime'), false);
    assert.equal(loser.includes('WorkflowStore'), false);
    assert.equal(loser.includes('DurableWorkflowCoordinator'), false);
    assert.equal(loser.includes('WorkflowScheduler'), false);
    assert.equal(loser.includes('WorkflowOccurrenceRunner'), false);
    assert.match(main, /second-instance/);
    assert.match(main, /app\.getPath\('userData'\)/);
    assert.match(main, /randomUUID\(\)/);
    assert.equal(main.includes('workflow:create'), false);
    assert.equal(main.includes('cron'), false);
    assert.equal(main.includes('daemon'), false);
  });

  it('does not add Workflows IPC channels or persist slot ownership', () => {
    const ipc = readFileSync(path.join(__dirname, 'ipc.ts'), 'utf8');
    const storeTypes = readFileSync(path.join(__dirname, '../workflows/workflow-store-types.ts'), 'utf8');
    const grants = readFileSync(path.join(__dirname, '../shared/interaction-types.ts'), 'utf8');
    const approval = readFileSync(path.join(__dirname, '../shared/approval-types.ts'), 'utf8');
    for (const channel of [
      'workflow:create',
      'workflow:edit',
      'workflow:list',
      'workflow:run-now',
      'workflow:enable',
      'workflow:disable',
      'workflow:delete',
      'workflow:review',
      'workflow:history',
    ]) {
      assert.equal(ipc.includes(channel), false, channel);
    }
    const occurrenceKeys = storeTypes.slice(
      storeTypes.indexOf('export const WORKFLOW_OCCURRENCE_KEYS'),
      storeTypes.indexOf('] as const', storeTypes.indexOf('export const WORKFLOW_OCCURRENCE_KEYS')),
    );
    for (const live of ['slot', 'reservation', 'lease', 'tabId', 'taskId']) {
      assert.equal(occurrenceKeys.includes(`'${live}'`), false, live);
    }
    const grantSlice = grants.slice(
      grants.indexOf('export interface InteractionGrant'),
      grants.indexOf('export interface InteractionResult'),
    );
    assert.equal(grantSlice.includes('workflowId'), false);
    assert.equal(approval.includes('occurrenceId'), false);
  });

  it('keeps renderer autonomous-task events independent of workflow observers', () => {
    const runtime = readFileSync(path.join(__dirname, 'ai-runtime.ts'), 'utf8');
    const emit = runtime.slice(runtime.indexOf('function emitAutonomousTaskEvent'));
    assert.match(emit, /sendToTrustedAppRenderer\(AUTONOMOUS_TASK_IPC_CHANNELS\.event/);
    assert.match(emit, /autonomousTaskEventListeners/);
    assert.ok(
      emit.indexOf('sendToTrustedAppRenderer') < emit.indexOf('autonomousTaskEventListeners'),
    );
  });
});

async function withDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-life-'));
  try {
    return await fn(directory);
  } finally {
    await removeDirectory(directory);
  }
}

async function removeDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
}

async function withRuntime(
  fn: (harness: { runtime: PersistentWorkflowRuntime; directory: string }) => Promise<void>,
): Promise<void> {
  await withDirectory(async (directory) => {
    let nowMs = BASE_TIME;
    const runtime = await PersistentWorkflowRuntime.initialize({
      directory,
      runtimeSessionId: 'runtime-test',
      now: () => new Date(nowMs += 1),
      timer: new FakeTimer(),
    });
    try {
      await fn({ runtime, directory });
    } finally {
      runtime.dispose();
    }
  });
}

async function enqueue(
  runtime: PersistentWorkflowRuntime,
  overrides: { name?: string; objective?: string; url?: string; enabled?: boolean } = {},
) {
  const coordinator = runtime.getCoordinator();
  assert.ok(coordinator);
  const workflow = await coordinator.createWorkflow(sampleInput(overrides));
  const occurrence = await coordinator.enqueueManualOccurrence(workflow.workflowId);
  return { workflow, occurrence };
}

function sampleInput(
  overrides: { name?: string; objective?: string; url?: string; enabled?: boolean } = {},
): CreateDurableWorkflowInput {
  return {
    name: overrides.name ?? 'Invoice check',
    objective: overrides.objective ?? 'Open the invoice page and summarize totals.',
    entryPoint: { kind: 'url', url: overrides.url ?? 'https://example.test/path' },
    trigger: { kind: 'manual' },
    enabled: overrides.enabled,
  };
}

function taskView(
  taskId: string,
  state: AutonomousTaskView['state'],
  extra: Partial<AutonomousTaskView> = {},
): AutonomousTaskView {
  return {
    taskId,
    state,
    plannerStepCount: 0,
    childRunCount: 0,
    ownedTabCount: extra.ownedTabIds?.length ?? 1,
    taskApprovalCount: 0,
    limits: VIEW_LIMITS,
    ownedTabIds: extra.ownedTabIds ?? ['tab-workflow'],
    ...extra,
  };
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeBrowser {
  readonly created: { url: string; activate: false }[] = [];
  failCreate: Error | undefined;

  async createTab(input: { url: string; activate: false }): Promise<TabId> {
    this.created.push(input);
    if (this.failCreate) {
      throw this.failCreate;
    }
    return 'tab-workflow';
  }

  async closeTab(): Promise<void> {}
}

class FakeTasks implements WorkflowExecutionTaskPort {
  readonly manualStarts: string[] = [];
  readonly trustedStarts: { taskId: string; tabId: TabId; objective: string }[] = [];
  readonly resumes: string[] = [];
  private activeTaskId: string | undefined;
  private paused = new Set<string>();
  private manuals = 0;
  private workflows = 0;

  constructor(private readonly emit?: (event: AutonomousTaskEvent) => void) {}

  hasActiveTask(): boolean {
    return this.activeTaskId !== undefined;
  }

  start(objective: string): AutonomousTaskStartResult {
    this.manualStarts.push(objective);
    if (this.activeTaskId) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'busy' } };
    }
    this.manuals += 1;
    const taskId = `task-manual-${this.manuals}`;
    this.activeTaskId = taskId;
    const task = taskView(taskId, 'planning', { ownedTabIds: ['tab-user'] });
    this.emit?.({ type: 'autonomous-task-started', task });
    return { ok: true, task };
  }

  startOnTrustedTab(tabId: TabId, objective: string): AutonomousTaskStartResult {
    if (this.activeTaskId) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'busy' } };
    }
    this.workflows += 1;
    const taskId = `task-workflow-${this.workflows}`;
    this.activeTaskId = taskId;
    this.trustedStarts.push({ taskId, tabId, objective });
    const task = taskView(taskId, 'planning', { ownedTabIds: [tabId] });
    this.emit?.({ type: 'autonomous-task-started', task });
    return { ok: true, task };
  }

  resume(taskId: string): AutonomousTaskControlResult {
    this.resumes.push(taskId);
    if (this.activeTaskId || !this.paused.has(taskId)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'busy' } };
    }
    this.paused.delete(taskId);
    this.activeTaskId = taskId;
    const task = taskView(taskId, 'planning');
    this.emit?.({ type: 'autonomous-task-resumed', task });
    return { ok: true, task };
  }

  async pause(taskId: string): Promise<AutonomousTaskControlResult> {
    this.activeTaskId = undefined;
    this.paused.add(taskId);
    const task = taskView(taskId, 'paused');
    this.emit?.({ type: 'autonomous-task-paused', task });
    return { ok: true, task };
  }

  async stop(taskId: string): Promise<AutonomousTaskControlResult> {
    this.activeTaskId = undefined;
    this.paused.delete(taskId);
    const task = taskView(taskId, 'cancelled', { terminalReason: 'USER_CANCELLED' });
    this.emit?.({ type: 'autonomous-task-cancelled', task });
    return { ok: true, task };
  }

  complete(taskId: string, answer: string): void {
    this.activeTaskId = undefined;
    this.emit?.({
      type: 'autonomous-task-completed',
      task: taskView(taskId, 'completed', { terminalReason: 'COMPLETED', completedAnswer: answer }),
    });
  }

  emitAwaitingApproval(taskId: string): void {
    this.emit?.({
      type: 'autonomous-task-awaiting-approval',
      task: taskView(taskId, 'awaiting-approval', { attention: 'approval' }),
    });
  }

  emitPaused(taskId: string): void {
    this.activeTaskId = undefined;
    this.emit?.({ type: 'autonomous-task-paused', task: taskView(taskId, 'paused') });
  }
}

async function assertManualUsableWithoutWorkflow(runtime: PersistentWorkflowRuntime): Promise<void> {
  const browser = new FakeBrowser();
  const tasks = new FakeTasks();
  runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
  const manual = runtime.startManualAutonomousTask('manual');
  assert.equal(manual.ok, true);
  assert.equal(browser.created.length, 0);
  assert.equal(tasks.trustedStarts.length, 0);
  assert.equal(runtime.getRunner(), undefined);
}

class CommitFailingStore implements WorkflowStorePort {
  private nextCommitError: unknown = undefined;

  constructor(private readonly inner: WorkflowStorePort) {}

  failNextCommit(error: unknown): void {
    this.nextCommitError = error;
  }

  load(): Promise<WorkflowStoreSnapshot> {
    return this.inner.load();
  }

  async commit(
    expectedStoreRevision: number,
    mutation: WorkflowStoreMutation,
  ): Promise<WorkflowStoreSnapshot> {
    if (this.nextCommitError !== undefined) {
      const error = this.nextCommitError;
      this.nextCommitError = undefined;
      throw error;
    }
    return this.inner.commit(expectedStoreRevision, mutation);
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

  setTimer(delayMs: number, callback: () => void | Promise<void>): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { delayMs, callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(label);
}
