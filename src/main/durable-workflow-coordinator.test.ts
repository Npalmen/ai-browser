import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DurableWorkflowCoordinator } from './durable-workflow-coordinator';
import { AtomicJsonWorkflowStore } from './workflow-store';
import { DurableWorkflowError } from '../workflows/durable-workflow-errors';
import {
  MAX_WORKFLOW_TRANSACTION_RETRIES,
  type CreateDurableWorkflowInput,
  type WorkflowStorePort,
} from '../workflows/durable-workflow-types';
import { WorkflowStoreError } from '../workflows/workflow-store-errors';
import {
  WORKFLOW_STORE_SCHEMA_VERSION,
  type DurableWorkflowDefinitionRecord,
  type WorkflowOccurrenceRecord,
  type WorkflowStoreMutation,
  type WorkflowStoreSnapshot,
} from '../workflows/workflow-store-types';

const BASE_TIME = Date.parse('2026-09-19T10:00:00.000Z');

describe('DurableWorkflowCoordinator', () => {
  it('locks the optimistic transaction retry bound', () => {
    assert.equal(MAX_WORKFLOW_TRANSACTION_RETRIES, 3);
  });

  it('creates a workflow, reloads from a new store instance, and keeps no-op initialize quiet', async () => {
    await withTempDir(async (directory) => {
      const storeA = new AtomicJsonWorkflowStore({ directory });
      const first = await createHarness({ store: storeA });
      const created = await first.coordinator.createWorkflow(sampleInput());
      assert.equal(created.definitionRevision, 1);
      assert.equal(created.reviewRequired, false);
      assert.equal(created.enabled, true);
      const revisionAfterCreate = (await storeA.load()).storeRevision;

      await createHarness({ store: storeA, runtimeSessionId: 'runtime-A' });
      assert.equal((await storeA.load()).storeRevision, revisionAfterCreate);

      const storeB = new AtomicJsonWorkflowStore({ directory });
      const second = await createHarness({ store: storeB });
      const reloaded = await second.coordinator.getWorkflow(created.workflowId);
      assert.deepEqual(reloaded, created);
    });
  });

  it('freezes occurrence snapshots across definition edits', async () => {
    const { coordinator } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput({ objective: 'first', url: 'https://example.com/a' }));
    const first = await coordinator.enqueueOccurrence({
      workflowId: workflow.workflowId,
      triggerKey: 'manual:one',
      scheduledFor: null,
      source: 'manual',
    });
    assert.equal(first.definitionRevision, 1);
    await coordinator.editWorkflow(workflow.workflowId, {
      name: 'Invoice check',
      objective: 'second',
      entryPoint: { kind: 'url', url: 'https://example.com/b' },
      trigger: { kind: 'manual' },
    });
    const second = await coordinator.enqueueOccurrence({
      workflowId: workflow.workflowId,
      triggerKey: 'manual:two',
      scheduledFor: null,
      source: 'manual',
    });
    const frozenFirst = await coordinator.getOccurrence(first.occurrenceId);
    assert.equal(frozenFirst?.definitionRevision, 1);
    assert.equal(frozenFirst?.frozenDefinition.objective, 'first');
    assert.equal(frozenFirst?.frozenDefinition.entryPoint.url, 'https://example.com/a');
    assert.equal(second.definitionRevision, 2);
    assert.equal(second.frozenDefinition.objective, 'second');
    assert.equal(second.frozenDefinition.entryPoint.url, 'https://example.com/b');
  });

  it('does not increment definitionRevision or storeRevision for a no-op edit', async () => {
    const { coordinator, store } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const before = (await store.load()).storeRevision;
    const edited = await coordinator.editWorkflow(workflow.workflowId, {
      name: workflow.name,
      objective: workflow.objective,
      entryPoint: workflow.entryPoint,
      trigger: workflow.trigger,
    });
    assert.equal(edited.definitionRevision, 1);
    assert.equal((await store.load()).storeRevision, before);
  });

  it('returns the existing occurrence for a duplicate triggerKey without writing', async () => {
    const { coordinator, store } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const first = await coordinator.enqueueOccurrence({
      workflowId: workflow.workflowId,
      triggerKey: 'sched:1',
      scheduledFor: '2026-09-19T12:00:00.000Z',
      source: 'scheduled',
    });
    const revision = (await store.load()).storeRevision;
    const second = await coordinator.enqueueOccurrence({
      workflowId: workflow.workflowId,
      triggerKey: 'sched:1',
      scheduledFor: '2026-09-19T12:00:00.000Z',
      source: 'scheduled',
    });
    assert.equal(second.occurrenceId, first.occurrenceId);
    assert.equal((await store.load()).storeRevision, revision);
    assert.equal((await coordinator.listOccurrences(workflow.workflowId)).length, 1);
  });

  it('lists queued occurrences in createdAt then occurrenceId FIFO order', async () => {
    const clock = new Clock();
    const ids = new IdFactory();
    const { coordinator } = await createHarness({ clock, ids });
    const workflow = await coordinator.createWorkflow(sampleInput());
    await coordinator.enqueueOccurrence({
      workflowId: workflow.workflowId,
      triggerKey: 'k-a',
      scheduledFor: null,
      source: 'manual',
    });
    await coordinator.enqueueOccurrence({
      workflowId: workflow.workflowId,
      triggerKey: 'k-b',
      scheduledFor: null,
      source: 'manual',
    });
    clock.tick();
    await coordinator.enqueueOccurrence({
      workflowId: workflow.workflowId,
      triggerKey: 'k-c',
      scheduledFor: null,
      source: 'manual',
    });
    const queued = await coordinator.listQueuedOccurrences();
    assert.deepEqual(
      queued.map((item) => item.triggerKey),
      ['k-a', 'k-b', 'k-c'],
    );
  });

  it('allows only one running occurrence', async () => {
    const { coordinator } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const first = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    const second = await enqueueQueued(coordinator, workflow.workflowId, 'two');
    const running = await coordinator.markOccurrenceRunning(first.occurrenceId);
    assert.equal(running.state, 'running');
    await assert.rejects(
      () => coordinator.markOccurrenceRunning(second.occurrenceId),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_BUSY',
    );
    assert.equal((await coordinator.getOccurrence(second.occurrenceId))?.state, 'queued');
  });

  it('completes a running occurrence without requiring review', async () => {
    const { coordinator } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    await coordinator.markOccurrenceRunning(queued.occurrenceId);
    const completed = await coordinator.terminalizeRunningOccurrence({
      occurrenceId: queued.occurrenceId,
      state: 'completed',
      finalAnswer: 'done',
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.ownerRuntimeSessionId, null);
    assert.equal(completed.finalAnswer, 'done');
    assert.ok(completed.finishedAt);
    assert.equal((await coordinator.getWorkflow(workflow.workflowId))?.reviewRequired, false);
  });

  it('sets reviewRequired atomically on execution-state-unknown and blocks enqueue', async () => {
    const { coordinator, store } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    await coordinator.markOccurrenceRunning(queued.occurrenceId);
    const before = (await store.load()).storeRevision;
    await coordinator.terminalizeRunningOccurrence({
      occurrenceId: queued.occurrenceId,
      state: 'execution-state-unknown',
    });
    const after = await store.load();
    assert.equal(after.storeRevision, before + 1);
    assert.equal(after.occurrences[0]?.state, 'execution-state-unknown');
    assert.equal(after.workflows[0]?.reviewRequired, true);
    await assert.rejects(
      () => enqueueQueued(coordinator, workflow.workflowId, 'two'),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_REVIEW_REQUIRED',
    );
  });

  it('recovers a foreign-session running occurrence to interrupted', async () => {
    await withTempDir(async (directory) => {
      const storeA = new AtomicJsonWorkflowStore({ directory });
      const first = await createHarness({ store: storeA, runtimeSessionId: 'runtime-A' });
      const workflow = await first.coordinator.createWorkflow(sampleInput());
      const queued = await enqueueQueued(first.coordinator, workflow.workflowId, 'one');
      await first.coordinator.markOccurrenceRunning(queued.occurrenceId);
      const revisionBefore = (await storeA.load()).storeRevision;

      const storeB = new AtomicJsonWorkflowStore({ directory });
      const recovered = await createHarness({ store: storeB, runtimeSessionId: 'runtime-B' });
      await recovered.coordinator.initialize('runtime-B');
      const occurrence = await recovered.coordinator.getOccurrence(queued.occurrenceId);
      const updated = await recovered.coordinator.getWorkflow(workflow.workflowId);
      assert.equal(occurrence?.state, 'interrupted');
      assert.equal(occurrence?.ownerRuntimeSessionId, null);
      assert.ok(occurrence?.finishedAt);
      assert.equal(occurrence?.finalAnswer, null);
      assert.equal(updated?.reviewRequired, true);
      assert.equal((await recovered.coordinator.listOccurrences(workflow.workflowId)).length, 1);
      await assert.rejects(
        () => recovered.coordinator.markOccurrenceRunning(queued.occurrenceId),
        (error: unknown) =>
          error instanceof DurableWorkflowError && error.code === 'WORKFLOW_OCCURRENCE_INVALID_STATE',
      );
      assert.ok((await storeB.load()).storeRevision > revisionBefore);
    });
  });

  it('does not interrupt a running occurrence owned by the current session', async () => {
    const { coordinator, store } = await createHarness({ runtimeSessionId: 'runtime-A' });
    const workflow = await coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    await coordinator.markOccurrenceRunning(queued.occurrenceId);
    const revision = (await store.load()).storeRevision;
    await coordinator.initialize('runtime-A');
    assert.equal((await coordinator.getOccurrence(queued.occurrenceId))?.state, 'running');
    assert.equal((await store.load()).storeRevision, revision);
  });

  it('acknowledgeReview clears the flag without replaying the occurrence', async () => {
    const { coordinator, store } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    await coordinator.markOccurrenceRunning(queued.occurrenceId);
    await coordinator.terminalizeRunningOccurrence({
      occurrenceId: queued.occurrenceId,
      state: 'execution-state-unknown',
    });
    const acknowledged = await coordinator.acknowledgeReview(workflow.workflowId);
    assert.equal(acknowledged.reviewRequired, false);
    const occurrence = await coordinator.getOccurrence(queued.occurrenceId);
    assert.equal(occurrence?.state, 'execution-state-unknown');
    assert.equal((await coordinator.listQueuedOccurrences()).length, 0);
    const revision = (await store.load()).storeRevision;
    await coordinator.acknowledgeReview(workflow.workflowId);
    assert.equal((await store.load()).storeRevision, revision);
  });

  it('acknowledgeReview does not enable a disabled workflow', async () => {
    const { coordinator } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput({ enabled: false }));
    await coordinator.setEnabled(workflow.workflowId, false);
    await forceReviewRequired(coordinator, workflow);
    const acknowledged = await coordinator.acknowledgeReview(workflow.workflowId);
    assert.equal(acknowledged.enabled, false);
    assert.equal(acknowledged.reviewRequired, false);
    assert.equal(await coordinator.getRunningOccurrence(), undefined);
  });

  it('rejects delete while an occurrence is running', async () => {
    const { coordinator, store } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    await coordinator.markOccurrenceRunning(queued.occurrenceId);
    const before = await store.load();
    await assert.rejects(
      () => coordinator.deleteWorkflow(workflow.workflowId),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_RUNNING',
    );
    const after = await store.load();
    assert.equal(after.storeRevision, before.storeRevision);
    assert.equal(after.workflows.length, 1);
    assert.equal(after.occurrences.length, 1);
  });

  it('deletes a workflow and all of its occurrences without touching others', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      const { coordinator } = await createHarness({ store });
      const keep = await coordinator.createWorkflow(sampleInput({ name: 'keep' }));
      const remove = await coordinator.createWorkflow(sampleInput({ name: 'remove' }));
      await enqueueQueued(coordinator, remove.workflowId, 'old');
      await coordinator.deleteWorkflow(remove.workflowId);
      const reloaded = await createHarness({ store: new AtomicJsonWorkflowStore({ directory }) });
      assert.equal(await reloaded.coordinator.getWorkflow(remove.workflowId), undefined);
      assert.equal((await reloaded.coordinator.listOccurrences(remove.workflowId)).length, 0);
      assert.equal((await reloaded.coordinator.getWorkflow(keep.workflowId))?.name, 'keep');
    });
  });

  it('cancels a queued occurrence without starting it', async () => {
    const { coordinator } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    const cancelled = await coordinator.cancelQueuedOccurrence(queued.occurrenceId);
    assert.equal(cancelled.state, 'cancelled');
    assert.ok(cancelled.finishedAt);
    await assert.rejects(
      () => coordinator.markOccurrenceRunning(queued.occurrenceId),
      (error: unknown) =>
        error instanceof DurableWorkflowError && error.code === 'WORKFLOW_OCCURRENCE_INVALID_STATE',
    );
  });

  it('rejects invalid occurrence transitions without writing', async () => {
    const { coordinator, store } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    await coordinator.markOccurrenceRunning(queued.occurrenceId);
    await coordinator.terminalizeRunningOccurrence({
      occurrenceId: queued.occurrenceId,
      state: 'completed',
      finalAnswer: 'done',
    });
    const revision = (await store.load()).storeRevision;
    await assertInvalidState(() => coordinator.markOccurrenceRunning(queued.occurrenceId));
    await assertInvalidState(() =>
      coordinator.terminalizeRunningOccurrence({
        occurrenceId: queued.occurrenceId,
        state: 'blocked',
        terminalReason: 'APPROVAL_REJECTED',
      }),
    );
    await assertInvalidState(() => coordinator.cancelQueuedOccurrence(queued.occurrenceId));
    const second = await enqueueQueued(coordinator, workflow.workflowId, 'two');
    await assertInvalidState(() =>
      coordinator.terminalizeRunningOccurrence({
        occurrenceId: second.occurrenceId,
        state: 'completed',
        finalAnswer: 'done',
      }),
    );
    assert.equal((await store.load()).storeRevision, revision + 1);
  });

  it('rejects scheduled and manual enqueue while disabled', async () => {
    const { coordinator } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    await coordinator.setEnabled(workflow.workflowId, false);
    await assert.rejects(
      () => enqueueQueued(coordinator, workflow.workflowId, 'manual'),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_DISABLED',
    );
    await assert.rejects(
      () =>
        coordinator.enqueueOccurrence({
          workflowId: workflow.workflowId,
          triggerKey: 'sched:disabled',
          scheduledFor: '2026-09-20T10:00:00.000Z',
          source: 'scheduled',
        }),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_DISABLED',
    );
    const queued = await coordinator.listQueuedOccurrences();
    assert.equal(queued.length, 0);
  });

  it('leaves already-queued occurrences durable after disable but refuses to start them', async () => {
    const { coordinator } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(coordinator, workflow.workflowId, 'one');
    await coordinator.setEnabled(workflow.workflowId, false);
    assert.equal((await coordinator.getOccurrence(queued.occurrenceId))?.state, 'queued');
    await assert.rejects(
      () => coordinator.markOccurrenceRunning(queued.occurrenceId),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_DISABLED',
    );
  });

  it('does not increment definitionRevision when toggling enabled', async () => {
    const { coordinator } = await createHarness();
    const workflow = await coordinator.createWorkflow(sampleInput());
    const disabled = await coordinator.setEnabled(workflow.workflowId, false);
    assert.equal(disabled.definitionRevision, 1);
    assert.equal(disabled.enabled, false);
  });

  it('freezes the winning definition revision when edit and enqueue race', async () => {
    const intercept = new InterceptStore(new MemoryWorkflowStore());
    const ids = new IdFactory();
    const clock = new Clock();
    const enqueuer = await createHarness({ store: intercept, ids, clock });
    const editor = await createHarness({ store: intercept, ids, clock, skipInitialize: true });
    await editor.coordinator.initialize('runtime-1');
    const workflow = await enqueuer.coordinator.createWorkflow(sampleInput({ objective: 'rev-1' }));

    intercept.beforeCommit = async () => {
      intercept.beforeCommit = undefined;
      await editor.coordinator.editWorkflow(workflow.workflowId, {
        name: 'Invoice check',
        objective: 'rev-2',
        entryPoint: { kind: 'url', url: 'https://example.com/path?resource=123' },
        trigger: { kind: 'manual' },
      });
    };
    const occurrence = await enqueuer.coordinator.enqueueOccurrence({
      workflowId: workflow.workflowId,
      triggerKey: 'race-key',
      scheduledFor: null,
      source: 'manual',
    });
    assert.equal(occurrence.definitionRevision, 2);
    assert.equal(occurrence.frozenDefinition.objective, 'rev-2');
  });

  it('does not enqueue after a winning disable, and keeps a winning enqueue queued after disable', async () => {
    const intercept = new InterceptStore(new MemoryWorkflowStore());
    const ids = new IdFactory();
    const clock = new Clock();
    const enqueuer = await createHarness({ store: intercept, ids, clock });
    const disabler = await createHarness({ store: intercept, ids, clock, skipInitialize: true });
    await disabler.coordinator.initialize('runtime-1');
    const workflow = await enqueuer.coordinator.createWorkflow(sampleInput());

    intercept.beforeCommit = async () => {
      intercept.beforeCommit = undefined;
      await disabler.coordinator.setEnabled(workflow.workflowId, false);
    };
    await assert.rejects(
      () => enqueueQueued(enqueuer.coordinator, workflow.workflowId, 'late'),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_DISABLED',
    );
    assert.equal((await enqueuer.coordinator.listQueuedOccurrences()).length, 0);

    const interceptB = new InterceptStore(new MemoryWorkflowStore());
    const idsB = new IdFactory();
    const enqueuerB = await createHarness({ store: interceptB, ids: idsB, clock });
    const disablerB = await createHarness({ store: interceptB, ids: idsB, clock, skipInitialize: true });
    await disablerB.coordinator.initialize('runtime-1');
    const workflowB = await enqueuerB.coordinator.createWorkflow(sampleInput());
    interceptB.beforeCommit = async () => {
      interceptB.beforeCommit = undefined;
      await enqueueQueued(enqueuerB.coordinator, workflowB.workflowId, 'early');
    };
    await disablerB.coordinator.setEnabled(workflowB.workflowId, false);
    const queued = await enqueuerB.coordinator.listQueuedOccurrences();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.state, 'queued');
    assert.equal((await enqueuerB.coordinator.getWorkflow(workflowB.workflowId))?.enabled, false);
  });

  it('does not enqueue after a winning delete', async () => {
    const intercept = new InterceptStore(new MemoryWorkflowStore());
    const ids = new IdFactory();
    const enqueuer = await createHarness({ store: intercept, ids });
    const deleter = await createHarness({ store: intercept, ids, skipInitialize: true });
    await deleter.coordinator.initialize('runtime-1');
    const workflow = await enqueuer.coordinator.createWorkflow(sampleInput());
    intercept.beforeCommit = async () => {
      intercept.beforeCommit = undefined;
      await deleter.coordinator.deleteWorkflow(workflow.workflowId);
    };
    await assert.rejects(
      () => enqueueQueued(enqueuer.coordinator, workflow.workflowId, 'ghost'),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_NOT_FOUND',
    );
  });

  it('refuses to start after a winning disable and does not stop an already-running occurrence', async () => {
    const intercept = new InterceptStore(new MemoryWorkflowStore());
    const ids = new IdFactory();
    const starter = await createHarness({ store: intercept, ids });
    const disabler = await createHarness({ store: intercept, ids, skipInitialize: true });
    await disabler.coordinator.initialize('runtime-1');
    const workflow = await starter.coordinator.createWorkflow(sampleInput());
    const queued = await enqueueQueued(starter.coordinator, workflow.workflowId, 'one');

    intercept.beforeCommit = async () => {
      intercept.beforeCommit = undefined;
      await disabler.coordinator.setEnabled(workflow.workflowId, false);
    };
    await assert.rejects(
      () => starter.coordinator.markOccurrenceRunning(queued.occurrenceId),
      (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_DISABLED',
    );

    const interceptB = new InterceptStore(new MemoryWorkflowStore());
    const idsB = new IdFactory();
    const starterB = await createHarness({ store: interceptB, ids: idsB });
    const disablerB = await createHarness({ store: interceptB, ids: idsB, skipInitialize: true });
    await disablerB.coordinator.initialize('runtime-1');
    const workflowB = await starterB.coordinator.createWorkflow(sampleInput());
    const queuedB = await enqueueQueued(starterB.coordinator, workflowB.workflowId, 'run');
    interceptB.beforeCommit = async () => {
      interceptB.beforeCommit = undefined;
      await starterB.coordinator.markOccurrenceRunning(queuedB.occurrenceId);
    };
    await disablerB.coordinator.setEnabled(workflowB.workflowId, false);
    assert.equal((await starterB.coordinator.getOccurrence(queuedB.occurrenceId))?.state, 'running');
    assert.equal((await starterB.coordinator.getWorkflow(workflowB.workflowId))?.enabled, false);
  });

  it('does not import browser, approval, model, or Electron modules', () => {
    const source = readFileSync(path.join(__dirname, 'durable-workflow-coordinator.ts'), 'utf8');
    for (const banned of [
      'electron',
      'BrowserAdapter',
      'ElectronBrowserAdapter',
      'AutonomousTaskController',
      'AgentRun',
      'ApprovalManager',
      'ExecuteExecutor',
      'InteractionExecutor',
      'AiSdkGatewayRuntime',
      'app.getPath',
      'requestSingleInstanceLock',
      'createTab',
      'navigate(',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
  });

  it('does not accept caller-supplied identity or live state on create/enqueue/edit types', () => {
    const types = readFileSync(path.join(__dirname, '..', 'workflows', 'durable-workflow-types.ts'), 'utf8');
    const createBlock = types.slice(
      types.indexOf('export interface CreateDurableWorkflowInput'),
      types.indexOf('export interface EditDurableWorkflowInput'),
    );
    const enqueueBlock = types.slice(
      types.indexOf('export interface EnqueueWorkflowOccurrenceInput'),
      types.indexOf('export interface TerminalizeRunningOccurrenceInput'),
    );
    for (const field of ['workflowId', 'definitionRevision', 'reviewRequired', 'createdAt', 'storeRevision']) {
      assert.equal(createBlock.includes(field), false, field);
    }
    for (const field of [
      'occurrenceId',
      'definitionRevision',
      'frozenDefinition',
      'state',
      'ownerRuntimeSessionId',
      'reviewRequired',
    ]) {
      assert.equal(enqueueBlock.includes(field), false, field);
    }
  });
});

async function assertInvalidState(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof DurableWorkflowError && error.code === 'WORKFLOW_OCCURRENCE_INVALID_STATE',
  );
}

async function enqueueQueued(
  coordinator: DurableWorkflowCoordinator,
  workflowId: string,
  key: string,
): Promise<WorkflowOccurrenceRecord> {
  return coordinator.enqueueOccurrence({
    workflowId,
    triggerKey: `manual:${key}`,
    scheduledFor: null,
    source: 'manual',
  });
}

async function forceReviewRequired(
  coordinator: DurableWorkflowCoordinator,
  workflow: DurableWorkflowDefinitionRecord,
): Promise<void> {
  await coordinator.setEnabled(workflow.workflowId, true);
  const queued = await enqueueQueued(coordinator, workflow.workflowId, `review-${workflow.workflowId}`);
  await coordinator.markOccurrenceRunning(queued.occurrenceId);
  await coordinator.terminalizeRunningOccurrence({
    occurrenceId: queued.occurrenceId,
    state: 'execution-state-unknown',
  });
  await coordinator.setEnabled(workflow.workflowId, false);
}

function sampleInput(
  overrides: { name?: string; objective?: string; url?: string; enabled?: boolean } = {},
): CreateDurableWorkflowInput {
  return {
    name: overrides.name ?? 'Invoice check',
    objective: overrides.objective ?? 'Open the invoice page and summarize totals.',
    entryPoint: { kind: 'url', url: overrides.url ?? 'https://example.com/path?resource=123' },
    trigger: { kind: 'manual' },
    enabled: overrides.enabled,
  };
}

async function createHarness(options: {
  store?: WorkflowStorePort;
  runtimeSessionId?: string;
  clock?: Clock;
  ids?: IdFactory;
  skipInitialize?: boolean;
} = {}): Promise<{
  coordinator: DurableWorkflowCoordinator;
  store: WorkflowStorePort;
  clock: Clock;
}> {
  const store = options.store ?? new MemoryWorkflowStore();
  const clock = options.clock ?? new Clock();
  const ids = options.ids ?? new IdFactory();
  const coordinator = new DurableWorkflowCoordinator({
    store,
    now: () => clock.now(),
    newWorkflowId: () => ids.nextWorkflowId(),
    newOccurrenceId: () => ids.nextOccurrenceId(),
  });
  if (!options.skipInitialize) {
    await coordinator.initialize(options.runtimeSessionId ?? 'runtime-1');
  }
  return { coordinator, store, clock };
}

class Clock {
  private current = BASE_TIME;

  now(): Date {
    return new Date(this.current);
  }

  tick(): void {
    this.current += 1000;
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
      throw new WorkflowStoreError('WORKFLOW_STORE_REVISION_CONFLICT', 'Workflow store revision conflict.');
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

class InterceptStore implements WorkflowStorePort {
  beforeCommit: (() => Promise<void>) | undefined;

  constructor(private readonly inner: WorkflowStorePort) {}

  load(): Promise<WorkflowStoreSnapshot> {
    return this.inner.load();
  }

  async commit(
    expectedStoreRevision: number,
    mutation: WorkflowStoreMutation,
  ): Promise<WorkflowStoreSnapshot> {
    if (this.beforeCommit) {
      await this.beforeCommit();
    }
    return this.inner.commit(expectedStoreRevision, mutation);
  }
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-coord-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
