import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DurableWorkflowCoordinator } from './durable-workflow-coordinator';
import { WorkflowOccurrenceRunner } from './workflow-occurrence-runner';
import { DurableWorkflowError } from '../workflows/durable-workflow-errors';
import type {
  CreateDurableWorkflowInput,
  TerminalizeRunningOccurrenceInput,
  WorkflowStorePort,
} from '../workflows/durable-workflow-types';
import {
  WORKFLOW_START_REASON,
  isTrustedWorkflowExecutionUrl,
  type WorkflowAutonomousTaskPort,
  type WorkflowBrowserStartupPort,
  type WorkflowOccurrenceDurablePort,
} from '../workflows/workflow-occurrence-runner-types';
import {
  WORKFLOW_STORE_SCHEMA_VERSION,
  type WorkflowOccurrenceRecord,
  type WorkflowStoreMutation,
  type WorkflowStoreSnapshot,
} from '../workflows/workflow-store-types';
import type { TabId } from '../shared/browser-types';
import type {
  AutonomousTaskEvent,
  AutonomousTaskStartResult,
  AutonomousTaskView,
} from '../shared/autonomous-task-types';

const BASE_TIME = Date.parse('2026-09-19T10:00:00.000Z');
const VIEW_LIMITS = {
  plannerSteps: 8,
  childRuns: 4,
  ownedTabs: 3,
  approvals: 4,
} as const;

describe('WorkflowOccurrenceRunner', () => {
  it('claims durable running before creating a background tab or starting V6', async () => {
    const harness = await createHarness();
    const { occurrence } = await enqueue(harness, {
      objective: 'Research A',
      url: 'https://example.test/a?keep=1',
    });
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'started');
    assert.deepEqual(harness.order, ['getOccurrence', 'markOccurrenceRunning', 'createTab', 'startOnTrustedTab']);
    assert.equal(harness.browser.created[0]?.activate, false);
    assert.equal(harness.browser.created[0]?.url, 'https://example.test/a?keep=1');
    assert.equal(harness.tasks.starts[0]?.tabId, 'tab-workflow');
    assert.equal(harness.tasks.starts[0]?.objective, 'Research A');
    assert.equal(harness.browser.activeTabId, 'tab-user');
    const running = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(running?.state, 'running');
    assert.equal(harness.runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);
    assert.equal(harness.runner.inspectLiveExecution()?.tabId, 'tab-workflow');
  });

  it('uses the frozen occurrence URL and objective after the current workflow is edited', async () => {
    const harness = await createHarness();
    const { workflow, occurrence } = await enqueue(harness, {
      objective: 'Research A',
      url: 'https://example.test/a',
    });
    await harness.coordinator.editWorkflow(workflow.workflowId, {
      name: workflow.name,
      objective: 'Research B',
      entryPoint: { kind: 'url', url: 'https://example.test/b' },
      trigger: { kind: 'manual' },
    });
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'started');
    assert.equal(harness.browser.created[0]?.url, 'https://example.test/a');
    assert.equal(harness.tasks.starts[0]?.objective, 'Research A');
    const current = await harness.coordinator.getWorkflow(workflow.workflowId);
    assert.equal(current?.objective, 'Research B');
    assert.equal(current?.entryPoint.url, 'https://example.test/b');
  });

  it('returns busy and leaves the occurrence queued when V6 already has an active task', async () => {
    const harness = await createHarness();
    harness.tasks.active = true;
    const { occurrence } = await enqueue(harness);
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'busy');
    assert.deepEqual(harness.browser.created, []);
    assert.deepEqual(harness.tasks.starts, []);
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'queued');
    assert.equal(harness.order.includes('markOccurrenceRunning'), false);
  });

  it('returns busy and leaves the second occurrence queued while one workflow execution is live', async () => {
    const harness = await createHarness();
    const first = await enqueue(harness, { name: 'First' });
    const second = await enqueue(harness, { name: 'Second', objective: 'Later' });
    const started = await harness.runner.startOccurrence(first.occurrence.occurrenceId);
    assert.equal(started.status, 'started');
    const busy = await harness.runner.startOccurrence(second.occurrence.occurrenceId);
    assert.equal(busy.status, 'busy');
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 1);
    assert.equal((await harness.coordinator.getOccurrence(second.occurrence.occurrenceId))?.state, 'queued');
  });

  it('creates no tab and no V6 task when mark-running fails', async () => {
    const harness = await createHarness({ failMark: true });
    const { occurrence } = await enqueue(harness);
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'failed');
    assert.deepEqual(harness.browser.created, []);
    assert.deepEqual(harness.tasks.starts, []);
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'queued');
  });

  it('terminalizes tab creation failure without persisting the raw error and without retry', async () => {
    const harness = await createHarness();
    harness.browser.failCreate = new Error('secret URL https://evil.test/leak');
    const { occurrence } = await enqueue(harness);
    const first = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(first.status, 'failed');
    const failed = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.terminalReason, WORKFLOW_START_REASON.TAB);
    assert.equal(failed?.terminalReason?.includes('secret'), false);
    assert.equal(failed?.terminalReason?.includes('evil.test'), false);
    assert.deepEqual(harness.tasks.starts, []);
    const retry = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(retry.status, 'failed');
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 0);
  });

  it('closes the unused tab and durable-fails when exact-tab V6 start fails', async () => {
    const harness = await createHarness();
    harness.tasks.fail = true;
    const { occurrence } = await enqueue(harness);
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'failed');
    assert.deepEqual(harness.browser.closed, ['tab-workflow']);
    const failed = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.terminalReason, WORKFLOW_START_REASON.V6);
    const retry = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(retry.status, 'failed');
    assert.equal(harness.browser.created.length, 1);
  });

  it('keeps durable failed truth when unused-tab close throws', async () => {
    const harness = await createHarness();
    harness.tasks.fail = true;
    harness.browser.failClose = new Error('close leaked');
    const { occurrence } = await enqueue(harness);
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'failed');
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.terminalReason, WORKFLOW_START_REASON.V6);
  });

  it('fails closed on a frozen javascript URL without creating a tab', async () => {
    const harness = await createHarness();
    const { occurrence } = await enqueue(harness);
    harness.durable.overrideFrozenUrl = 'javascript:alert(1)';
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'failed');
    assert.deepEqual(harness.browser.created, []);
    assert.deepEqual(harness.tasks.starts, []);
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.terminalReason, WORKFLOW_START_REASON.TAB);
  });

  it('keeps a createTab startup terminal pending when durable fail cannot be persisted', async () => {
    const harness = await createHarness();
    harness.browser.failCreate = new Error('secret URL https://evil.test/leak');
    harness.durable.failTerminal = true;
    const { occurrence } = await enqueue(harness);
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'failed');
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(harness.runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);
    assert.equal(harness.runner.inspectLiveExecution(), undefined);
    assert.equal(harness.tasks.starts.length, 0);
    assert.equal(harness.browser.created.length, 1);
    harness.durable.failTerminal = false;
    await harness.runner.reconcilePendingTerminal();
    const terminal = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.terminalReason, WORKFLOW_START_REASON.TAB);
    assert.equal(terminal?.terminalReason?.includes('secret'), false);
    assert.equal(harness.runner.getActiveOccurrence(), undefined);
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 0);
  });

  it('keeps an invalid frozen URL startup terminal pending when persist fails', async () => {
    const harness = await createHarness();
    harness.durable.overrideFrozenUrl = 'javascript:alert(1)';
    harness.durable.failTerminal = true;
    const { occurrence } = await enqueue(harness);
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'failed');
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(harness.runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);
    assert.equal(harness.runner.inspectLiveExecution(), undefined);
    assert.deepEqual(harness.browser.created, []);
    assert.deepEqual(harness.tasks.starts, []);
    harness.durable.failTerminal = false;
    await harness.runner.reconcilePendingTerminal();
    const terminal = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.terminalReason, WORKFLOW_START_REASON.TAB);
    assert.equal(harness.runner.getActiveOccurrence(), undefined);
    assert.equal(harness.browser.created.length, 0);
    assert.equal(harness.tasks.starts.length, 0);
  });

  it('keeps a V6 start failure terminal pending without retrying the tab or task', async () => {
    const harness = await createHarness();
    harness.tasks.fail = true;
    harness.durable.failTerminal = true;
    const { occurrence } = await enqueue(harness);
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'failed');
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(harness.runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);
    assert.equal(harness.runner.inspectLiveExecution(), undefined);
    assert.deepEqual(harness.browser.closed, ['tab-workflow']);
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 1);
    harness.durable.failTerminal = false;
    await harness.runner.reconcilePendingTerminal();
    const terminal = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.terminalReason, WORKFLOW_START_REASON.V6);
    assert.equal(harness.runner.getActiveOccurrence(), undefined);
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 1);
  });

  it('does not let unused-tab close failure erase a pending V6 startup terminal', async () => {
    const harness = await createHarness();
    harness.tasks.fail = true;
    harness.browser.failClose = new Error('close leaked');
    harness.durable.failTerminal = true;
    const { occurrence } = await enqueue(harness);
    const result = await harness.runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(result.status, 'failed');
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(harness.runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);
    assert.equal(harness.runner.inspectLiveExecution(), undefined);
    harness.durable.failTerminal = false;
    await harness.runner.reconcilePendingTerminal();
    const terminal = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.terminalReason, WORKFLOW_START_REASON.V6);
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 1);
  });

  it('returns busy for a second occurrence while startup terminal bookkeeping is pending', async () => {
    const harness = await createHarness();
    harness.browser.failCreate = new Error('tab start failed');
    harness.durable.failTerminal = true;
    const first = await enqueue(harness, { name: 'First' });
    const second = await enqueue(harness, { name: 'Second', objective: 'Later' });
    const failed = await harness.runner.startOccurrence(first.occurrence.occurrenceId);
    assert.equal(failed.status, 'failed');
    const busy = await harness.runner.startOccurrence(second.occurrence.occurrenceId);
    assert.equal(busy.status, 'busy');
    assert.equal((await harness.coordinator.getOccurrence(second.occurrence.occurrenceId))?.state, 'queued');
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 0);
    harness.durable.failTerminal = false;
    harness.browser.failCreate = undefined;
    await harness.runner.reconcilePendingTerminal();
    assert.equal(harness.runner.getActiveOccurrence(), undefined);
    const started = await harness.runner.startOccurrence(second.occurrence.occurrenceId);
    assert.equal(started.status, 'started');
    assert.equal((await harness.coordinator.getOccurrence(first.occurrence.occurrenceId))?.state, 'failed');
    assert.equal(harness.browser.created.length, 2);
    assert.equal(harness.tasks.starts.length, 1);
  });

  it('retries the same startup terminal fact across repeated reconciliation failures', async () => {
    const harness = await createHarness();
    harness.browser.failCreate = new Error('tab start failed');
    harness.durable.failTerminal = true;
    const { occurrence } = await enqueue(harness);
    await harness.runner.startOccurrence(occurrence.occurrenceId);
    await harness.runner.reconcilePendingTerminal();
    await harness.runner.reconcilePendingTerminal();
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(harness.runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);
    assert.equal(harness.durable.terminalCalls >= 3, true);
    harness.durable.failTerminal = false;
    await harness.runner.reconcilePendingTerminal();
    const terminal = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.terminalReason, WORKFLOW_START_REASON.TAB);
    assert.equal(harness.runner.getActiveOccurrence(), undefined);
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 0);
  });

  it('ignores unrelated V6 events while a startup terminal is pending reconciliation', async () => {
    const harness = await createHarness();
    harness.browser.failCreate = new Error('tab start failed');
    harness.durable.failTerminal = true;
    const { occurrence } = await enqueue(harness);
    await harness.runner.startOccurrence(occurrence.occurrenceId);
    const afterStart = await harness.store.load();
    await harness.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-started', { taskId: 'task-manual', state: 'planning' }),
    );
    await harness.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-completed', {
        taskId: 'task-workflow',
        state: 'completed',
        terminalReason: 'COMPLETED',
        completedAnswer: 'Must not bind.',
      }),
    );
    const afterEvents = await harness.store.load();
    assert.equal(afterEvents.storeRevision, afterStart.storeRevision);
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(harness.runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);
    assert.equal(harness.runner.inspectLiveExecution(), undefined);
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 0);
  });

  it('maps live runtime loss to unknown and keeps a startup-pending failed fact', async () => {
    const live = await createHarness();
    const liveOcc = await enqueue(live);
    await live.runner.startOccurrence(liveOcc.occurrence.occurrenceId);
    await live.runner.handleExecutionRuntimeUnavailable();
    const unknown = await live.coordinator.getOccurrence(liveOcc.occurrence.occurrenceId);
    assert.equal(unknown?.state, 'execution-state-unknown');
    assert.equal((await live.coordinator.getWorkflow(liveOcc.workflow.workflowId))?.reviewRequired, true);
    assert.equal(live.browser.created.length, 1);
    assert.equal(live.tasks.starts.length, 1);

    const pending = await createHarness();
    pending.browser.failCreate = new Error('tab start failed');
    pending.durable.failTerminal = true;
    const pendingOcc = await enqueue(pending);
    await pending.runner.startOccurrence(pendingOcc.occurrence.occurrenceId);
    await pending.runner.handleExecutionRuntimeUnavailable();
    assert.equal((await pending.coordinator.getOccurrence(pendingOcc.occurrence.occurrenceId))?.state, 'running');
    pending.durable.failTerminal = false;
    await pending.runner.reconcilePendingTerminal();
    assert.equal(
      (await pending.coordinator.getOccurrence(pendingOcc.occurrence.occurrenceId))?.terminalReason,
      WORKFLOW_START_REASON.TAB,
    );
    assert.equal(pending.browser.created.length, 1);
    assert.equal(pending.tasks.starts.length, 0);
  });

  it('maps V6 completed to a durable completed occurrence with the bounded answer', async () => {
    const harness = await createHarness();
    const { occurrence } = await enqueue(harness);
    await harness.runner.startOccurrence(occurrence.occurrenceId);
    await harness.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-completed', {
        state: 'completed',
        terminalReason: 'COMPLETED',
        completedAnswer: 'Totals are $12.',
      }),
    );
    const terminal = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'completed');
    assert.equal(terminal?.finalAnswer, 'Totals are $12.');
    assert.equal(harness.runner.inspectLiveExecution(), undefined);
  });

  it('fail-closes completed without a bounded answer', async () => {
    const harness = await createHarness();
    const { occurrence } = await enqueue(harness);
    await harness.runner.startOccurrence(occurrence.occurrenceId);
    await harness.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-completed', {
        state: 'completed',
        terminalReason: 'COMPLETED',
      }),
    );
    const terminal = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.terminalReason, WORKFLOW_START_REASON.RESULT_MISSING);
    assert.equal(terminal?.finalAnswer, null);
  });

  it('maps V6 blocked, failed, cancelled, and unknown without retry', async () => {
    const blocked = await createHarness();
    const blockedOcc = await enqueue(blocked);
    await blocked.runner.startOccurrence(blockedOcc.occurrence.occurrenceId);
    await blocked.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-blocked', {
        state: 'blocked',
        terminalReason: 'APPROVAL_REJECTED',
      }),
    );
    assert.equal((await blocked.coordinator.getOccurrence(blockedOcc.occurrence.occurrenceId))?.state, 'blocked');
    assert.equal(
      (await blocked.coordinator.getOccurrence(blockedOcc.occurrence.occurrenceId))?.terminalReason,
      'APPROVAL_REJECTED',
    );
    assert.equal(blocked.tasks.starts.length, 1);

    const failed = await createHarness();
    const failedOcc = await enqueue(failed);
    await failed.runner.startOccurrence(failedOcc.occurrence.occurrenceId);
    await failed.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-failed', {
        state: 'failed',
        terminalReason: 'PLANNER_FAILED',
      }),
    );
    assert.equal((await failed.coordinator.getOccurrence(failedOcc.occurrence.occurrenceId))?.state, 'failed');

    const cancelled = await createHarness();
    const cancelledOcc = await enqueue(cancelled);
    await cancelled.runner.startOccurrence(cancelledOcc.occurrence.occurrenceId);
    await cancelled.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-cancelled', {
        state: 'cancelled',
        terminalReason: 'USER_CANCELLED',
      }),
    );
    const cancelledTerminal = await cancelled.coordinator.getOccurrence(cancelledOcc.occurrence.occurrenceId);
    assert.equal(cancelledTerminal?.state, 'blocked');
    assert.equal(cancelledTerminal?.terminalReason, 'USER_CANCELLED');

    const unknown = await createHarness();
    const unknownOcc = await enqueue(unknown);
    await unknown.runner.startOccurrence(unknownOcc.occurrence.occurrenceId);
    await unknown.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-execution-state-unknown', {
        state: 'execution-state-unknown',
        terminalReason: 'EXECUTION_STATE_UNKNOWN',
      }),
    );
    const unknownTerminal = await unknown.coordinator.getOccurrence(unknownOcc.occurrence.occurrenceId);
    assert.equal(unknownTerminal?.state, 'execution-state-unknown');
    const workflow = await unknown.coordinator.getWorkflow(unknownOcc.workflow.workflowId);
    assert.equal(workflow?.reviewRequired, true);
    assert.equal(unknown.tasks.starts.length, 1);
  });

  it('keeps the occurrence running for paused, awaiting-approval, and awaiting-user-input', async () => {
    const harness = await createHarness();
    const { occurrence } = await enqueue(harness);
    await harness.runner.startOccurrence(occurrence.occurrenceId);
    for (const type of [
      'autonomous-task-started',
      'autonomous-task-progress',
      'autonomous-task-awaiting-approval',
      'autonomous-task-awaiting-user-input',
      'autonomous-task-paused',
      'autonomous-task-resumed',
    ] as const) {
      await harness.runner.handleAutonomousTaskEvent(taskEvent(type, { state: 'paused' }));
    }
    const live = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(live?.state, 'running');
    assert.equal(harness.runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);
  });

  it('ignores a duplicate terminal event after a successful durable commit', async () => {
    const harness = await createHarness();
    const { occurrence } = await enqueue(harness);
    await harness.runner.startOccurrence(occurrence.occurrenceId);
    const afterStart = await harness.store.load();
    const event = taskEvent('autonomous-task-blocked', {
      state: 'blocked',
      terminalReason: 'TASK_NO_PROGRESS',
    });
    await harness.runner.handleAutonomousTaskEvent(event);
    const afterFirst = await harness.store.load();
    await harness.runner.handleAutonomousTaskEvent(event);
    const afterSecond = await harness.store.load();
    assert.ok(afterFirst.storeRevision > afterStart.storeRevision);
    assert.equal(afterSecond.storeRevision, afterFirst.storeRevision);
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'blocked');
  });

  it('ignores unrelated manual Delegate task events', async () => {
    const harness = await createHarness();
    const { occurrence } = await enqueue(harness);
    await harness.runner.startOccurrence(occurrence.occurrenceId);
    const afterStart = await harness.store.load();
    await harness.runner.handleAutonomousTaskEvent(
      taskEvent(
        'autonomous-task-completed',
        {
          taskId: 'task-manual',
          state: 'completed',
          terminalReason: 'COMPLETED',
          completedAnswer: 'Manual answer',
        },
      ),
    );
    const afterEvent = await harness.store.load();
    assert.equal(afterEvent.storeRevision, afterStart.storeRevision);
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(harness.runner.inspectLiveExecution()?.taskId, 'task-workflow');
  });

  it('keeps correlation after a terminal persist failure and reconciles the same fact later', async () => {
    const harness = await createHarness();
    const { occurrence } = await enqueue(harness);
    await harness.runner.startOccurrence(occurrence.occurrenceId);
    harness.durable.failTerminal = true;
    await harness.runner.handleAutonomousTaskEvent(
      taskEvent('autonomous-task-completed', {
        state: 'completed',
        terminalReason: 'COMPLETED',
        completedAnswer: 'Kept for bookkeeping.',
      }),
    );
    assert.equal((await harness.coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(harness.runner.inspectLiveExecution()?.occurrenceId, occurrence.occurrenceId);
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 1);
    harness.durable.failTerminal = false;
    await harness.runner.reconcilePendingTerminal();
    const terminal = await harness.coordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'completed');
    assert.equal(terminal?.finalAnswer, 'Kept for bookkeeping.');
    assert.equal(harness.runner.inspectLiveExecution(), undefined);
    assert.equal(harness.browser.created.length, 1);
    assert.equal(harness.tasks.starts.length, 1);
  });

  it('rejects untrusted execution URLs without rewriting them', () => {
    assert.equal(isTrustedWorkflowExecutionUrl('https://example.test/a?x=1'), true);
    assert.equal(isTrustedWorkflowExecutionUrl('http://127.0.0.1/path'), true);
    assert.equal(isTrustedWorkflowExecutionUrl('javascript:alert(1)'), false);
    assert.equal(isTrustedWorkflowExecutionUrl('file:///tmp/x'), false);
    assert.equal(isTrustedWorkflowExecutionUrl('data:text/html,hi'), false);
    assert.equal(isTrustedWorkflowExecutionUrl('about:blank'), false);
    assert.equal(isTrustedWorkflowExecutionUrl('blob:https://example.test/1'), false);
    assert.equal(isTrustedWorkflowExecutionUrl('chrome://settings'), false);
    assert.equal(isTrustedWorkflowExecutionUrl('https://user:pass@example.test/'), false);
  });

  it('does not call interaction primitives, restore live refs, or wire scheduler/runtime', () => {
    const runner = readFileSync(path.join(__dirname, 'workflow-occurrence-runner.ts'), 'utf8');
    const types = readFileSync(path.join(__dirname, '../workflows/workflow-occurrence-runner-types.ts'), 'utf8');
    const storeTypes = readFileSync(path.join(__dirname, '../workflows/workflow-store-types.ts'), 'utf8');
    const scheduler = readFileSync(path.join(__dirname, 'workflow-scheduler.ts'), 'utf8');
    const runtime = readFileSync(path.join(__dirname, 'ai-runtime.ts'), 'utf8');
    const main = readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    const grants = readFileSync(path.join(__dirname, '../shared/interaction-types.ts'), 'utf8');
    const approval = readFileSync(path.join(__dirname, '../shared/approval-types.ts'), 'utf8');
    for (const token of [
      '.click(',
      '.type(',
      '.select(',
      '.scroll(',
      'scrollIntoView',
      'InteractionExecutor',
      'ExecuteExecutor',
      'ApprovalManager',
      'PrepareActionService',
      'ApprovalController',
      'setInterval',
      'while queued',
    ]) {
      assert.equal(runner.includes(token), false, token);
    }
    assert.match(runner, /activate: false/);
    assert.match(runner, /frozenDefinition\.entryPoint\.url/);
    assert.match(runner, /frozenDefinition\.objective/);
    assert.equal(runner.includes('startOccurrence(occurrenceId'), true);
    assert.equal(types.includes('tabId: TabId;\n  objective'), false);
    assert.equal(scheduler.includes('WorkflowOccurrenceRunner'), false);
    assert.equal(scheduler.includes('startOccurrence'), false);
    assert.equal(runtime.includes('WorkflowOccurrenceRunner'), false);
    assert.equal(main.includes('WorkflowOccurrenceRunner'), false);
    assert.match(main, /app\.requestSingleInstanceLock\(\)/);
    const occurrenceKeys = storeTypes.slice(
      storeTypes.indexOf('export const WORKFLOW_OCCURRENCE_KEYS'),
      storeTypes.indexOf(
        '] as const',
        storeTypes.indexOf('export const WORKFLOW_OCCURRENCE_KEYS'),
      ),
    );
    for (const live of ['tabId', 'taskId', 'generation', 'AgentRunRef', 'targetId', 'approvalId', 'grant']) {
      assert.equal(occurrenceKeys.includes(`'${live}'`), false, live);
    }
    assert.match(storeTypes, /FORBIDDEN_WORKFLOW_STORE_FIELD_NAMES[\s\S]*'tabId'/);
    assert.match(storeTypes, /FORBIDDEN_WORKFLOW_STORE_FIELD_NAMES[\s\S]*'taskId'/);
    const grantSlice = grants.slice(grants.indexOf('export interface InteractionGrant'), grants.indexOf('export interface InteractionResult'));
    const prepared = approval.slice(approval.indexOf('export interface PreparedAction '), approval.indexOf('export type ApprovalDecisionValue'));
    const decision = approval.slice(approval.indexOf('export interface ApprovalDecision'), approval.indexOf('export interface ExecuteGrant'));
    const execute = approval.slice(approval.indexOf('export interface ExecuteGrant'), approval.indexOf('export interface PreparedActionRecordSnapshot'));
    for (const slice of [grantSlice, prepared, decision, execute]) {
      assert.equal(slice.includes('workflowId'), false);
      assert.equal(slice.includes('occurrenceId'), false);
    }
  });
});

async function createHarness(options: { failMark?: boolean } = {}) {
  const clock = new Clock();
  const ids = new IdFactory();
  const store = new MemoryWorkflowStore();
  const coordinator = new DurableWorkflowCoordinator({
    store,
    now: () => clock.now(),
    newWorkflowId: () => ids.nextWorkflowId(),
    newOccurrenceId: () => ids.nextOccurrenceId(),
  });
  await coordinator.initialize('runtime-1');
  const order: string[] = [];
  const browser = new FakeWorkflowBrowser(order);
  const tasks = new FakeWorkflowTasks(order);
  const durable = new RecordingDurable(coordinator, order, { failMark: options.failMark === true });
  const runner = new WorkflowOccurrenceRunner({
    durable,
    browser,
    autonomousTasks: tasks,
  });
  return { coordinator, store, browser, tasks, durable, runner, clock, order };
}

async function enqueue(
  harness: Awaited<ReturnType<typeof createHarness>>,
  overrides: { name?: string; objective?: string; url?: string } = {},
) {
  const workflow = await harness.coordinator.createWorkflow(sampleInput(overrides));
  const occurrence = await harness.coordinator.enqueueManualOccurrence(workflow.workflowId);
  return { workflow, occurrence };
}

function sampleInput(
  overrides: { name?: string; objective?: string; url?: string } = {},
): CreateDurableWorkflowInput {
  return {
    name: overrides.name ?? 'Invoice check',
    objective: overrides.objective ?? 'Open the invoice page and summarize totals.',
    entryPoint: { kind: 'url', url: overrides.url ?? 'https://example.test/path?resource=123' },
    trigger: { kind: 'manual' },
  };
}

function taskEvent(
  type: AutonomousTaskEvent['type'],
  overrides: Partial<AutonomousTaskView> = {},
): AutonomousTaskEvent {
  return {
    type,
    task: {
      taskId: 'task-workflow',
      state: 'planning',
      plannerStepCount: 0,
      childRunCount: 0,
      ownedTabCount: 1,
      taskApprovalCount: 0,
      limits: VIEW_LIMITS,
      ownedTabIds: ['tab-workflow'],
      ...overrides,
    },
  };
}

class FakeWorkflowBrowser implements WorkflowBrowserStartupPort {
  readonly created: { url: string; activate: false }[] = [];
  readonly closed: TabId[] = [];
  activeTabId: TabId = 'tab-user';
  failCreate: Error | undefined;
  failClose: Error | undefined;

  constructor(private readonly order: string[]) {}

  async createTab(input: { url: string; activate: false }): Promise<TabId> {
    this.order.push('createTab');
    this.created.push(input);
    if (this.failCreate) {
      throw this.failCreate;
    }
    return 'tab-workflow';
  }

  async closeTab(tabId: TabId): Promise<void> {
    this.closed.push(tabId);
    if (this.failClose) {
      throw this.failClose;
    }
  }
}

class FakeWorkflowTasks implements WorkflowAutonomousTaskPort {
  readonly starts: { tabId: TabId; objective: string }[] = [];
  active = false;
  fail = false;

  constructor(private readonly order: string[]) {}

  hasActiveTask(): boolean {
    return this.active;
  }

  startOnTrustedTab(tabId: TabId, objective: string): AutonomousTaskStartResult {
    this.order.push('startOnTrustedTab');
    this.starts.push({ tabId, objective });
    if (this.fail) {
      return { ok: false, error: { code: 'AI_REQUEST_FAILED', message: 'Task failed to start.' } };
    }
    this.active = true;
    return {
      ok: true,
      task: {
        taskId: 'task-workflow',
        state: 'planning',
        plannerStepCount: 0,
        childRunCount: 0,
        ownedTabCount: 1,
        taskApprovalCount: 0,
        limits: VIEW_LIMITS,
        ownedTabIds: [tabId],
      },
    };
  }
}

class RecordingDurable implements WorkflowOccurrenceDurablePort {
  failTerminal = false;
  overrideFrozenUrl: string | undefined;
  terminalCalls = 0;

  constructor(
    private readonly inner: DurableWorkflowCoordinator,
    private readonly order: string[],
    private readonly options: { failMark: boolean },
  ) {}

  async getOccurrence(occurrenceId: string) {
    this.order.push('getOccurrence');
    const occurrence = await this.inner.getOccurrence(occurrenceId);
    if (occurrence && this.overrideFrozenUrl) {
      return withFrozenUrl(occurrence, this.overrideFrozenUrl);
    }
    return occurrence;
  }

  async markOccurrenceRunning(occurrenceId: string) {
    this.order.push('markOccurrenceRunning');
    if (this.options.failMark) {
      throw new DurableWorkflowError('WORKFLOW_CONCURRENT_MODIFICATION', 'Injected mark-running failure.');
    }
    const running = await this.inner.markOccurrenceRunning(occurrenceId);
    if (this.overrideFrozenUrl) {
      return withFrozenUrl(running, this.overrideFrozenUrl);
    }
    return running;
  }

  async terminalizeRunningOccurrence(input: TerminalizeRunningOccurrenceInput) {
    this.terminalCalls += 1;
    if (this.failTerminal) {
      throw new Error('persist failed');
    }
    return this.inner.terminalizeRunningOccurrence(input);
  }
}

function withFrozenUrl(occurrence: WorkflowOccurrenceRecord, url: string): WorkflowOccurrenceRecord {
  return {
    ...occurrence,
    frozenDefinition: {
      ...occurrence.frozenDefinition,
      entryPoint: { kind: 'url', url },
    },
  };
}

class Clock {
  private current = BASE_TIME;

  now(): Date {
    return new Date(this.current);
  }
}

class IdFactory {
  private workflows = 0;
  private occurrences = 0;

  nextWorkflowId(): string {
    this.workflows += 1;
    return `wf-${this.workflows}`;
  }

  nextOccurrenceId(): string {
    this.occurrences += 1;
    return `occ-${this.occurrences}`;
  }
}

class MemoryWorkflowStore implements WorkflowStorePort {
  private snapshot: WorkflowStoreSnapshot = {
    schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
    storeRevision: 0,
    workflows: [],
    occurrences: [],
  };

  async load(): Promise<WorkflowStoreSnapshot> {
    return structuredClone(this.snapshot);
  }

  async commit(
    expectedStoreRevision: number,
    mutation: WorkflowStoreMutation,
  ): Promise<WorkflowStoreSnapshot> {
    if (expectedStoreRevision !== this.snapshot.storeRevision) {
      throw new Error('Workflow store revision conflict.');
    }
    const payload = mutation(structuredClone(this.snapshot));
    this.snapshot = {
      schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
      storeRevision: this.snapshot.storeRevision + 1,
      workflows: structuredClone(payload.workflows),
      occurrences: structuredClone(payload.occurrences),
    };
    return structuredClone(this.snapshot);
  }
}
