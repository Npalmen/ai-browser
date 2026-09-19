import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PersistentWorkflowRuntime } from '../main/persistent-workflow-runtime';
import type { WorkflowExecutionTaskPort } from '../main/persistent-workflow-runtime';
import { WorkflowProductController } from '../main/workflow-product-controller';
import type {
  AutonomousTaskControlResult,
  AutonomousTaskEvent,
  AutonomousTaskStartResult,
  AutonomousTaskView,
} from '../shared/autonomous-task-types';
import type { TabId } from '../shared/browser-types';
import { FakeTimer, sampleWorkflow, withTempDirectory } from './runtime-helpers';

const LIMITS = {
  plannerSteps: 8,
  childRuns: 4,
  ownedTabs: 3,
  approvals: 4,
} as const;

describe('V7 lifecycle and slot acceptance', () => {
  it('rejects manual Delegate while a workflow durable claim is pending', async () => {
    await withRuntime(async (runtime) => {
      const { occurrence } = await enqueue(runtime, 'A');
      const gate = deferred();
      runtime.setMarkRunningGate(() => gate.promise);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const drain = runtime.flush();
      await waitUntil(() => runtime.getSlotOwner()?.kind === 'workflow');
      const manual = runtime.startManualAutonomousTask('manual now');
      assert.equal(manual.ok, false);
      assert.equal(tasks.manualStarts.length, 0);
      gate.resolve();
      await drain;
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      assert.equal(tasks.trustedStarts.length, 1);
    });
  });

  it('keeps a queued workflow queued while manual Delegate owns the slot', async () => {
    await withRuntime(async (runtime) => {
      await enqueue(runtime, 'Queued');
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const manual = runtime.startManualAutonomousTask('user first');
      assert.equal(manual.ok, true);
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.listQueuedOccurrences())?.[0]?.state, 'queued');
      assert.equal(browser.created.length, 0);
      tasks.complete(manual.ok ? manual.task.taskId : '', 'done');
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.listQueuedOccurrences())?.length, 0);
      assert.equal(browser.created.length, 1);
    });
  });

  it('rejects Resume of a paused manual task while a workflow owns the slot', async () => {
    await withRuntime(async (runtime) => {
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const manual = runtime.startManualAutonomousTask('pause me');
      assert.equal(manual.ok, true);
      if (!manual.ok) {
        return;
      }
      await runtime.pauseAutonomousTask(manual.task.taskId);
      await enqueue(runtime, 'Workflow next');
      await runtime.flush();
      const resumed = runtime.resumeManualAutonomousTask(manual.task.taskId);
      assert.equal(resumed.ok, false);
      assert.equal(runtime.getSlotOwner()?.kind, 'workflow');
    });
  });

  it('starts eligible FIFO rows and skips disabled/review-required older rows', async () => {
    await withRuntime(async (runtime) => {
      const blocked = await enqueue(runtime, 'Blocked');
      const eligible = await enqueue(runtime, 'Eligible');
      const later = await enqueue(runtime, 'Later');
      await runtime.getCoordinator()?.markScheduleReviewRequired(blocked.workflow.workflowId);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(eligible.occurrence.occurrenceId))?.state,
        'running',
      );
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(blocked.occurrence.occurrenceId))?.state,
        'queued',
      );
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(later.occurrence.occurrenceId))?.state,
        'queued',
      );
    });
  });

  it('queues without an execution binding and starts the same occurrence after attach', async () => {
    await withRuntime(async (runtime) => {
      const { occurrence } = await enqueue(runtime, 'No window');
      assert.equal(occurrence.state, 'queued');
      assert.equal(runtime.getRunner(), undefined);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state,
        'running',
      );
      assert.equal(browser.created.length, 1);
      assert.equal(tasks.trustedStarts.length, 1);
    });
  });

  it('notifies after durable create/run/ack/delete and not after a failed terminal commit', async () => {
    await withRuntime(async (runtime) => {
      const notifications: number[] = [];
      runtime.subscribeStateChanged(() => {
        notifications.push(Date.now());
      });
      const created = await runtime.createWorkflow(sampleWorkflow({ name: 'Notify' }));
      const afterCreate = notifications.length;
      assert.ok(afterCreate >= 1);
      await runtime.runWorkflowNow(created.workflowId);
      assert.ok(notifications.length > afterCreate);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      const live = runtime.getRunner()?.inspectLiveExecution();
      assert.ok(live);
      const gate = deferred();
      runtime.setTerminalizeGate(() => gate.promise);
      const beforeUnknown = notifications.length;
      tasks.emitUnknown(live.taskId);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(live.occurrenceId))?.state,
        'running',
      );
      assert.equal(notifications.length, beforeUnknown);
      gate.resolve();
      await runtime.flush();
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(live.occurrenceId))?.state,
        'execution-state-unknown',
      );
      assert.ok(notifications.length > beforeUnknown);
    });
  });

  it('keeps a disabled queued occurrence durable without starting it', async () => {
    await withRuntime(async (runtime) => {
      const { occurrence } = await enqueue(runtime, 'Disabled');
      await runtime.setWorkflowEnabled(occurrence.workflowId, false);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'queued');
      assert.equal(browser.created.length, 0);
      await runtime.setWorkflowEnabled(occurrence.workflowId, true);
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      assert.equal(browser.created.length, 1);
    });
  });

  it('holds the slot while a workflow task is paused and while startup terminalization is pending', async () => {
    await withRuntime(async (runtime) => {
      const { occurrence } = await enqueue(runtime, 'Pause me');
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      const live = runtime.getRunner()?.inspectLiveExecution();
      assert.ok(live);
      await runtime.pauseAutonomousTask(live.taskId);
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      assert.equal(runtime.getSlotOwner()?.kind, 'workflow');
      const manual = runtime.startManualAutonomousTask('manual during pause');
      assert.equal(manual.ok, false);
    });

    await withRuntime(async (runtime) => {
      await enqueue(runtime, 'Startup fail');
      const gate = deferred();
      runtime.setTerminalizeGate(() => gate.promise);
      const browser = new FakeBrowser();
      browser.createTab = async () => {
        throw new Error('tab failed');
      };
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      const drain = runtime.flush();
      await waitUntil(() => runtime.getRunner()?.hasPendingTerminal() === true, 'startup pending');
      const manual = runtime.startManualAutonomousTask('manual during pending terminal');
      assert.equal(manual.ok, false);
      assert.equal(tasks.trustedStarts.length, 0);
      gate.resolve();
      await drain;
      await runtime.flush();
      assert.equal(runtime.getSlotOwner(), undefined);
    });
  });

  it('drops a stale manual slot on detach and starts a queued workflow on a fresh binding', async () => {
    await withRuntime(async (runtime) => {
      await enqueue(runtime, 'After detach');
      const first = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser: new FakeBrowser(), autonomousTasks: first });
      const manual = runtime.startManualAutonomousTask('stale manual');
      assert.equal(manual.ok, true);
      runtime.detachExecutionRuntime();
      await runtime.flush();
      assert.equal(runtime.getSlotOwner(), undefined);
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      assert.equal(browser.created.length, 1);
      assert.equal(tasks.trustedStarts.length, 1);
      assert.notEqual(tasks.trustedStarts[0]?.taskId, manual.ok ? manual.task.taskId : '');
    });
  });

  it('marks live workflow loss unknown and disables auto-run if that terminal cannot persist', async () => {
    await withRuntime(async (runtime) => {
      const { occurrence } = await enqueue(runtime, 'Live loss');
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      assert.equal((await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state, 'running');
      runtime.detachExecutionRuntime();
      await runtime.flush();
      assert.equal(
        (await runtime.getCoordinator()?.getOccurrence(occurrence.occurrenceId))?.state,
        'execution-state-unknown',
      );
      assert.equal((await runtime.getCoordinator()?.getWorkflow(occurrence.workflowId))?.reviewRequired, true);
    });

    await withRuntime(async (runtime) => {
      await enqueue(runtime, 'Persist fail');
      const browser = new FakeBrowser();
      const tasks = new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event));
      runtime.attachExecutionRuntime({ browser, autonomousTasks: tasks });
      await runtime.flush();
      runtime.setTerminalizeGate(() => Promise.reject(new Error('durable unavailable')));
      runtime.detachExecutionRuntime();
      await runtime.flush();
      const later = new FakeBrowser();
      runtime.attachExecutionRuntime({
        browser: later,
        autonomousTasks: new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event)),
      });
      await runtime.flush();
      assert.equal(later.created.length, 0);
    });
  });

  it('maps workflow product stop/cancel identity and storage-error mutations', async () => {
    await withRuntime(async (runtime) => {
      const controller = new WorkflowProductController(runtime);
      const first = await controller.create(sampleWorkflow({ name: 'A' }));
      const second = await controller.create(sampleWorkflow({ name: 'B', url: 'https://example.test/b' }));
      assert.equal(first.ok && second.ok, true);
      if (!first.ok || !second.ok || !first.workflowId || !second.workflowId) {
        return;
      }
      await controller.runNow(first.workflowId);
      const extra = await runtime.getCoordinator()?.enqueueManualOccurrence(first.workflowId);
      runtime.attachExecutionRuntime({
        browser: new FakeBrowser(),
        autonomousTasks: new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event)),
      });
      await runtime.flush();
      const stopOther = await controller.stop(second.workflowId);
      assert.equal(stopOther.ok, false);
      const cancelOther = await controller.cancelQueued(second.workflowId, extra!.occurrenceId);
      assert.equal(cancelOther.ok, false);
      assert.equal((await runtime.getCoordinator()?.getOccurrence(extra!.occurrenceId))?.state, 'queued');
    });
  });
});

async function withRuntime(fn: (runtime: PersistentWorkflowRuntime) => Promise<void>): Promise<void> {
  await withTempDirectory(async (directory) => {
    let nowMs = Date.parse('2026-09-19T10:00:00.000Z');
    const runtime = await PersistentWorkflowRuntime.initialize({
      directory,
      runtimeSessionId: 'runtime-life',
      now: () => new Date((nowMs += 1)),
      timer: new FakeTimer(),
    });
    try {
      await fn(runtime);
    } finally {
      runtime.dispose();
    }
  });
}

async function enqueue(runtime: PersistentWorkflowRuntime, name: string) {
  const workflow = await runtime.createWorkflow(sampleWorkflow({ name }));
  const occurrence = await runtime.runWorkflowNow(workflow.workflowId);
  return { workflow, occurrence };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, label = 'timeout'): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(label);
}

function taskView(taskId: string, state: AutonomousTaskView['state'], tabId = 'tab-workflow'): AutonomousTaskView {
  return {
    taskId,
    state,
    plannerStepCount: 0,
    childRunCount: 0,
    ownedTabCount: 1,
    taskApprovalCount: 0,
    limits: LIMITS,
    ownedTabIds: [tabId],
  };
}

class FakeBrowser {
  readonly created: { url: string; activate: false }[] = [];
  async createTab(input: { url: string; activate: false }): Promise<TabId> {
    this.created.push(input);
    return 'tab-workflow';
  }
  async closeTab(): Promise<void> {}
}

class FakeTasks implements WorkflowExecutionTaskPort {
  readonly manualStarts: string[] = [];
  readonly trustedStarts: { taskId: string; tabId: TabId; objective: string }[] = [];
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
    const task = taskView(taskId, 'planning', 'tab-user');
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
    const task = taskView(taskId, 'planning', tabId);
    this.emit?.({ type: 'autonomous-task-started', task });
    return { ok: true, task };
  }

  resume(taskId: string): AutonomousTaskControlResult {
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
    const task = taskView(taskId, 'cancelled');
    this.emit?.({ type: 'autonomous-task-cancelled', task });
    return { ok: true, task };
  }

  complete(taskId: string, answer: string): void {
    this.activeTaskId = undefined;
    this.emit?.({
      type: 'autonomous-task-completed',
      task: { ...taskView(taskId, 'completed'), terminalReason: 'COMPLETED', completedAnswer: answer },
    });
  }

  emitUnknown(taskId: string): void {
    this.activeTaskId = undefined;
    this.emit?.({
      type: 'autonomous-task-execution-state-unknown',
      task: { ...taskView(taskId, 'execution-state-unknown'), terminalReason: 'EXECUTION_STATE_UNKNOWN' },
    });
  }
}
