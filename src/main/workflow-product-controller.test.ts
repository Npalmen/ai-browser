import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { WorkflowProductController, toOccurrenceView, toWorkflowSummaryView } from './workflow-product-controller';
import { PersistentWorkflowRuntime } from './persistent-workflow-runtime';
import { WORKFLOW_STORE_CANONICAL_FILENAME } from './workflow-store';
import type {
  DurableWorkflowDefinitionRecord,
  WorkflowOccurrenceRecord,
} from '../workflows/workflow-store-types';
import type { SchedulerTimerPort } from '../workflows/workflow-scheduler-types';
import type {
  AutonomousTaskControlResult,
  AutonomousTaskEvent,
  AutonomousTaskStartResult,
  AutonomousTaskView,
} from '../shared/autonomous-task-types';
import type { TabId } from '../shared/browser-types';
import type { WorkflowExecutionTaskPort } from './persistent-workflow-runtime';

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-09-19T10:00:00.000Z');

describe('workflow product controller', () => {
  it('projects summaries, last results, and next runs without live IDs', () => {
    const workflow = definition({
      workflowId: 'wf-1',
      trigger: {
        kind: 'schedule',
        schedule: { kind: 'one-time', runAtUtc: '2026-09-20T08:00:00.000Z' },
      },
    });
    const queued: WorkflowOccurrenceRecord = occurrence({
      occurrenceId: 'occ-q',
      state: 'queued',
      finishedAt: null,
    });
    const older: WorkflowOccurrenceRecord = occurrence({
      occurrenceId: 'occ-old',
      state: 'completed',
      finishedAt: '2026-09-18T10:00:00.000Z',
      finalAnswer: 'older',
    });
    const newer: WorkflowOccurrenceRecord = occurrence({
      occurrenceId: 'occ-new',
      state: 'failed',
      finishedAt: '2026-09-19T09:00:00.000Z',
      finalAnswer: 'newer',
    });
    const summary = toWorkflowSummaryView(workflow, [queued, older, newer], NOW);
    assert.equal(summary.nextRunAt, '2026-09-20T08:00:00.000Z');
    assert.equal(summary.queuedCount, 1);
    assert.equal(summary.running, false);
    assert.equal(summary.lastResult?.state, 'failed');
    assert.equal(summary.lastResult?.finalAnswer, 'newer');
    const view = toOccurrenceView(
      occurrence({
        triggerKey: 'manual:occ-1',
        ownerRuntimeSessionId: 'runtime-secret',
        frozenDefinition: {
          objective: 'hidden',
          entryPoint: { kind: 'url', url: 'https://example.test' },
          trigger: { kind: 'manual' },
        },
      }),
    );
    assert.equal(view.source, 'manual');
    assert.equal('triggerKey' in view, false);
    assert.equal('ownerRuntimeSessionId' in view, false);
    assert.equal('frozenDefinition' in view, false);
    assert.equal('runtimeSessionId' in view, false);
  });

  it('does not let an invalid timezone break other workflow views or substitute UTC', () => {
    const invalid = toWorkflowSummaryView(
      definition({
        workflowId: 'wf-bad',
        trigger: {
          kind: 'schedule',
          schedule: { kind: 'recurring-daily', timeZone: 'Mars/Olympus_Mons', hour: 9, minute: 0 },
        },
      }),
      [],
      NOW,
    );
    const valid = toWorkflowSummaryView(definition({ workflowId: 'wf-good' }), [], NOW);
    assert.equal(invalid.nextRunAt, null);
    assert.equal(valid.workflowId, 'wf-good');
  });

  it('creates, lists, and runs now without an execution binding', async () => {
    await withRuntime(async (runtime) => {
      const controller = new WorkflowProductController(runtime);
      const created = await controller.create({
        name: 'Nightly',
        objective: 'Check invoices',
        entryPoint: { kind: 'url', url: 'https://example.test/invoices' },
        trigger: {
          kind: 'schedule',
          schedule: { kind: 'one-time', runAtUtc: '2026-09-21T08:00:00.000Z' },
        },
        enabled: true,
      });
      assert.equal(created.ok, true);
      if (!created.ok) {
        return;
      }
      const state = await controller.getState(NOW);
      assert.equal(state.ok, true);
      if (!state.ok) {
        return;
      }
      assert.equal(state.status, 'ready');
      assert.equal(state.workflows.length, 1);
      assert.equal(state.workflows[0]?.workflowId, created.workflowId);
      const run = await controller.runNow(created.workflowId as string);
      assert.equal(run.ok, true);
      const queued = await runtime.getCoordinator()?.listQueuedOccurrences();
      assert.equal(queued?.length, 1);
      assert.equal(queued?.[0]?.scheduledFor, null);
      assert.equal(queued?.[0]?.triggerKey.startsWith('manual:'), true);
      assert.equal(queued?.[0]?.workflowId, created.workflowId);
      const workflow = await runtime.getCoordinator()?.getWorkflow(created.workflowId as string);
      assert.equal(workflow?.trigger.kind, 'schedule');
      if (workflow?.trigger.kind === 'schedule') {
        assert.equal(workflow.trigger.schedule.kind, 'one-time');
      }
    });
  });

  it('blocks run-now while review is required and acknowledge does not replay', async () => {
    await withRuntime(async (runtime) => {
      const controller = new WorkflowProductController(runtime);
      const created = await controller.create({
        name: 'Review me',
        objective: 'Do work',
        entryPoint: { kind: 'url', url: 'https://example.test/a' },
        trigger: { kind: 'manual' },
      });
      assert.equal(created.ok, true);
      if (!created.ok || !created.workflowId) {
        return;
      }
      const queued = await runtime.getCoordinator()?.enqueueManualOccurrence(created.workflowId);
      assert.ok(queued);
      await runtime.getCoordinator()?.markScheduleReviewRequired(created.workflowId);
      const before = await runtime.getCoordinator()?.listOccurrences(created.workflowId);
      const blocked = await controller.runNow(created.workflowId);
      assert.equal(blocked.ok, false);
      if (!blocked.ok) {
        assert.equal(blocked.error.code, 'WORKFLOW_REVIEW_REQUIRED');
      }
      const afterBlocked = await runtime.getCoordinator()?.listOccurrences(created.workflowId);
      assert.equal(afterBlocked?.length, before?.length);
      const ack = await controller.acknowledgeReview(created.workflowId);
      assert.equal(ack.ok, true);
      const workflow = await runtime.getCoordinator()?.getWorkflow(created.workflowId);
      assert.equal(workflow?.reviewRequired, false);
      const afterAck = await runtime.getCoordinator()?.listOccurrences(created.workflowId);
      assert.equal(afterAck?.[0]?.occurrenceId, queued?.occurrenceId);
      assert.equal(afterAck?.[0]?.state, 'queued');
    });
  });

  it('keeps queued and running rows when disabled and refuses to delete a running workflow', async () => {
    await withRuntime(async (runtime) => {
      const controller = new WorkflowProductController(runtime);
      const created = await controller.create({
        name: 'Live',
        objective: 'Do work',
        entryPoint: { kind: 'url', url: 'https://example.test/a' },
        trigger: { kind: 'manual' },
      });
      assert.equal(created.ok, true);
      if (!created.ok || !created.workflowId) {
        return;
      }
      await controller.runNow(created.workflowId);
      const extra = await runtime.getCoordinator()?.enqueueManualOccurrence(created.workflowId);
      runtime.attachExecutionRuntime({ browser: new FakeBrowser(), autonomousTasks: new FakeTasks() });
      await runtime.flush();
      const running = await runtime.getCoordinator()?.getRunningOccurrence();
      assert.equal(running?.state, 'running');
      const disabled = await controller.setEnabled(created.workflowId, false);
      assert.equal(disabled.ok, true);
      const stillRunning = await runtime.getCoordinator()?.getOccurrence(running!.occurrenceId);
      const stillQueued = await runtime.getCoordinator()?.getOccurrence(extra!.occurrenceId);
      assert.equal(stillRunning?.state, 'running');
      assert.equal(stillQueued?.state, 'queued');
      const deleted = await controller.delete(created.workflowId);
      assert.equal(deleted.ok, false);
      if (!deleted.ok) {
        assert.equal(deleted.error.code, 'WORKFLOW_RUNNING');
      }
      assert.ok(await runtime.getCoordinator()?.getWorkflow(created.workflowId));
    });
  });

  it('stops only the matching active workflow and cancels only matching queued occurrences', async () => {
    await withRuntime(async (runtime) => {
      const controller = new WorkflowProductController(runtime);
      const first = await controller.create({
        name: 'A',
        objective: 'A work',
        entryPoint: { kind: 'url', url: 'https://example.test/a' },
        trigger: { kind: 'manual' },
      });
      const second = await controller.create({
        name: 'B',
        objective: 'B work',
        entryPoint: { kind: 'url', url: 'https://example.test/b' },
        trigger: { kind: 'manual' },
      });
      assert.equal(first.ok && second.ok, true);
      if (!first.ok || !second.ok || !first.workflowId || !second.workflowId) {
        return;
      }
      await controller.runNow(first.workflowId);
      const otherQueued = await runtime.getCoordinator()?.enqueueManualOccurrence(first.workflowId);
      runtime.attachExecutionRuntime({
        browser: new FakeBrowser(),
        autonomousTasks: new FakeTasks((event) => runtime.handleAutonomousTaskEvent(event)),
      });
      await runtime.flush();
      const stopOther = await controller.stop(second.workflowId);
      assert.equal(stopOther.ok, false);
      assert.equal(runtime.getRunner()?.getActiveOccurrence()?.workflowId, first.workflowId);
      const cancelOther = await controller.cancelQueued(second.workflowId, otherQueued!.occurrenceId);
      assert.equal(cancelOther.ok, false);
      assert.equal((await runtime.getCoordinator()?.getOccurrence(otherQueued!.occurrenceId))?.state, 'queued');
      const cancelled = await controller.cancelQueued(first.workflowId, otherQueued!.occurrenceId);
      assert.equal(cancelled.ok, true);
      assert.equal((await runtime.getCoordinator()?.getOccurrence(otherQueued!.occurrenceId))?.state, 'cancelled');
    });
  });

  it('returns storage-error as a product state and fails mutations safely', async () => {
    await withDirectory(async (directory) => {
      await fs.writeFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME), '{not-json', 'utf8');
      const runtime = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-corrupt',
        timer: new FakeTimer(),
      });
      const controller = new WorkflowProductController(runtime);
      const state = await controller.getState();
      assert.deepEqual(state, { ok: true, status: 'storage-error', workflows: [] });
      const created = await controller.create({
        name: 'Nope',
        objective: 'Nope',
        entryPoint: { kind: 'url', url: 'https://example.test/a' },
        trigger: { kind: 'manual' },
      });
      assert.equal(created.ok, false);
      if (!created.ok) {
        assert.equal(created.error.code, 'WORKFLOW_STORAGE_ERROR');
        assert.equal(created.error.message.includes(directory), false);
      }
      runtime.dispose();
    });
  });

  it('does not take browser, model, or approval authority', () => {
    const source = readFileSync(path.join(ROOT, 'src/main/workflow-product-controller.ts'), 'utf8');
    for (const banned of [
      'BrowserAdapter',
      'InteractionExecutor',
      'ExecuteExecutor',
      'ApprovalManager',
      'startAsk',
      'createTab',
      'whenBrowserReady',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
  });
});

async function withRuntime(fn: (runtime: PersistentWorkflowRuntime) => Promise<void>): Promise<void> {
  await withDirectory(async (directory) => {
    let nowMs = Date.parse('2026-09-19T10:00:00.000Z');
    const runtime = await PersistentWorkflowRuntime.initialize({
      directory,
      runtimeSessionId: 'runtime-product',
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

async function withDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-product-'));
  try {
    return await fn(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function definition(
  overrides: Partial<DurableWorkflowDefinitionRecord> = {},
): DurableWorkflowDefinitionRecord {
  return {
    workflowId: 'wf-1',
    definitionRevision: 1,
    name: 'Named',
    objective: 'Do the thing',
    entryPoint: { kind: 'url', url: 'https://example.test' },
    trigger: { kind: 'manual' },
    enabled: true,
    reviewRequired: false,
    createdAt: '2026-09-19T09:00:00.000Z',
    updatedAt: '2026-09-19T09:00:00.000Z',
    ...overrides,
  };
}

function occurrence(overrides: Partial<WorkflowOccurrenceRecord> = {}): WorkflowOccurrenceRecord {
  return {
    occurrenceId: 'occ-1',
    workflowId: 'wf-1',
    definitionRevision: 1,
    triggerKey: 'wf-1:2026-09-19T08:00:00.000Z',
    scheduledFor: '2026-09-19T08:00:00.000Z',
    frozenDefinition: {
      objective: 'frozen',
      entryPoint: { kind: 'url', url: 'https://example.test' },
      trigger: { kind: 'manual' },
    },
    state: 'completed',
    createdAt: '2026-09-19T08:00:00.000Z',
    startedAt: '2026-09-19T08:01:00.000Z',
    finishedAt: '2026-09-19T08:02:00.000Z',
    ownerRuntimeSessionId: 'runtime-1',
    terminalReason: 'COMPLETED',
    finalAnswer: 'done',
    ...overrides,
  };
}

class FakeBrowser {
  async createTab(): Promise<TabId> {
    return 'tab-workflow';
  }
  async closeTab(): Promise<void> {}
}

class FakeTasks implements WorkflowExecutionTaskPort {
  private activeTaskId: string | undefined;
  constructor(private readonly emit?: (event: AutonomousTaskEvent) => void) {}
  hasActiveTask(): boolean {
    return this.activeTaskId !== undefined;
  }
  start(): AutonomousTaskStartResult {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'unused' } };
  }
  startOnTrustedTab(tabId: TabId, objective: string): AutonomousTaskStartResult {
    this.activeTaskId = 'task-workflow-1';
    const task = taskView('task-workflow-1', tabId, objective);
    this.emit?.({ type: 'autonomous-task-started', task });
    return { ok: true, task };
  }
  resume(): AutonomousTaskControlResult {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'unused' } };
  }
  async pause(): Promise<AutonomousTaskControlResult> {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'unused' } };
  }
  async stop(taskId: string): Promise<AutonomousTaskControlResult> {
    this.activeTaskId = undefined;
    const task = taskView(taskId, 'tab-workflow');
    this.emit?.({ type: 'autonomous-task-cancelled', task: { ...task, state: 'cancelled' } });
    return { ok: true, task: { ...task, state: 'cancelled' } };
  }
}

function taskView(taskId: string, tabId: string, _objective?: string): AutonomousTaskView {
  return {
    taskId,
    state: 'planning',
    plannerStepCount: 0,
    childRunCount: 0,
    ownedTabCount: 1,
    taskApprovalCount: 0,
    limits: { plannerSteps: 8, childRuns: 4, ownedTabs: 3, approvals: 4 },
    ownedTabIds: [tabId],
  };
}

class FakeTimer implements SchedulerTimerPort {
  private nextId = 1;
  private readonly timers = new Map<number, { delayMs: number; callback: () => void | Promise<void> }>();
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
