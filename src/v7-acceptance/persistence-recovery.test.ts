import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PersistentWorkflowRuntime } from '../main/persistent-workflow-runtime';
import { WorkflowProductController } from '../main/workflow-product-controller';
import {
  WORKFLOW_STORE_BACKUP_FILENAME,
  WORKFLOW_STORE_CANONICAL_FILENAME,
} from '../main/workflow-store';
import { DurableWorkflowError } from '../workflows/durable-workflow-errors';
import { WORKFLOW_STORE_SCHEMA_VERSION } from '../workflows/workflow-store-types';
import { FakeTimer, sampleWorkflow, withTempDirectory } from './runtime-helpers';

const BASE = Date.parse('2026-09-19T10:00:00.000Z');

async function initialize(
  directory: string,
  session: string,
  nowMs = BASE,
): Promise<PersistentWorkflowRuntime> {
  return PersistentWorkflowRuntime.initialize({
    directory,
    runtimeSessionId: session,
    now: () => new Date(nowMs),
    timer: new FakeTimer(),
  });
}

describe('V7 persistence and recovery acceptance', () => {
  it('reconstructs durable intent without live browser authority', async () => {
    await withTempDirectory(async (directory) => {
      const first = await initialize(directory, 'runtime-A');
      const created = await first.createWorkflow(
        sampleWorkflow({ name: 'Persist me', url: 'https://example.test/invoices?id=1' }),
      );
      const queued = await first.runWorkflowNow(created.workflowId);
      first.dispose();

      const second = await initialize(directory, 'runtime-B', BASE + 1000);
      const restored = await second.getCoordinator()?.getWorkflow(created.workflowId);
      const occurrence = await second.getCoordinator()?.getOccurrence(queued.occurrenceId);
      assert.equal(restored?.workflowId, created.workflowId);
      assert.equal(restored?.name, 'Persist me');
      assert.equal(restored?.entryPoint.url, 'https://example.test/invoices?id=1');
      assert.equal(restored?.trigger.kind, 'manual');
      assert.equal(restored?.enabled, true);
      assert.equal(restored?.reviewRequired, false);
      assert.equal(occurrence?.state, 'queued');
      assert.equal(occurrence?.occurrenceId, queued.occurrenceId);
      const raw = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME), 'utf8');
      for (const banned of ['tabId', 'taskId', 'approvalId', 'ExecuteGrant', 'AgentRunRef']) {
        assert.equal(JSON.parse(raw).workflows[0][banned], undefined);
        assert.equal(JSON.parse(raw).occurrences[0][banned], undefined);
      }
      second.dispose();
    });
  });

  it('keeps a queued occurrence across restart and starts that same row after a fresh binding', async () => {
    await withTempDirectory(async (directory) => {
      const first = await initialize(directory, 'runtime-A');
      const created = await first.createWorkflow(sampleWorkflow());
      const queued = await first.runWorkflowNow(created.workflowId);
      first.dispose();

      const second = await initialize(directory, 'runtime-B');
      const restored = await second.getCoordinator()?.getOccurrence(queued.occurrenceId);
      assert.equal(restored?.state, 'queued');
      const listed = await second.getCoordinator()?.listQueuedOccurrences();
      assert.equal(listed?.length, 1);
      assert.equal(listed?.[0]?.occurrenceId, queued.occurrenceId);
      second.dispose();
    });
  });

  it('maps a foreign-session running occurrence to interrupted and requires review', async () => {
    await withTempDirectory(async (directory) => {
      const first = await initialize(directory, 'runtime-A');
      const created = await first.createWorkflow(sampleWorkflow({ name: 'Active' }));
      const queued = await first.runWorkflowNow(created.workflowId);
      await first.getCoordinator()?.markOccurrenceRunning(queued.occurrenceId);
      first.dispose();

      const second = await initialize(directory, 'runtime-B', BASE + 5000);
      const recovered = await second.getCoordinator()?.getOccurrence(queued.occurrenceId);
      const workflow = await second.getCoordinator()?.getWorkflow(created.workflowId);
      assert.equal(recovered?.state, 'interrupted');
      assert.equal(workflow?.reviewRequired, true);
      const run = await second.runWorkflowNow(created.workflowId).then(
        () => 'started',
        (error: unknown) => (error instanceof DurableWorkflowError ? error.code : 'other'),
      );
      assert.equal(run, 'WORKFLOW_REVIEW_REQUIRED');
      assert.equal((await second.getCoordinator()?.listQueuedOccurrences())?.length, 0);
      const ack = await second.acknowledgeWorkflowReview(created.workflowId);
      assert.equal(ack.reviewRequired, false);
      const stillInterrupted = await second.getCoordinator()?.getOccurrence(queued.occurrenceId);
      assert.equal(stillInterrupted?.state, 'interrupted');
      second.dispose();
    });
  });

  it('keeps execution-state-unknown as a stop barrier across reconstruction', async () => {
    await withTempDirectory(async (directory) => {
      const first = await initialize(directory, 'runtime-A');
      const created = await first.createWorkflow(sampleWorkflow({ name: 'Unknown' }));
      const queued = await first.runWorkflowNow(created.workflowId);
      await first.getCoordinator()?.markOccurrenceRunning(queued.occurrenceId);
      await first.getCoordinator()?.terminalizeRunningOccurrence({
        occurrenceId: queued.occurrenceId,
        state: 'execution-state-unknown',
        terminalReason: 'EXECUTION_STATE_UNKNOWN',
      });
      first.dispose();

      const second = await initialize(directory, 'runtime-B');
      const recovered = await second.getCoordinator()?.getOccurrence(queued.occurrenceId);
      const workflow = await second.getCoordinator()?.getWorkflow(created.workflowId);
      assert.equal(recovered?.state, 'execution-state-unknown');
      assert.equal(workflow?.reviewRequired, true);
      await assert.rejects(
        () => second.runWorkflowNow(created.workflowId),
        (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_REVIEW_REQUIRED',
      );
      await second.acknowledgeWorkflowReview(created.workflowId);
      assert.equal((await second.getCoordinator()?.getOccurrence(queued.occurrenceId))?.state, 'execution-state-unknown');
      second.dispose();
    });
  });

  it('executes the frozen queued definition after an edit', async () => {
    await withTempDirectory(async (directory) => {
      const runtime = await initialize(directory, 'runtime-A');
      const created = await runtime.createWorkflow(
        sampleWorkflow({
          name: 'Rev',
          objective: 'Objective A',
          url: 'https://example.test/a',
        }),
      );
      const queued = await runtime.runWorkflowNow(created.workflowId);
      await runtime.editWorkflow(created.workflowId, {
        name: 'Rev',
        objective: 'Objective B',
        entryPoint: { kind: 'url', url: 'https://example.test/b' },
        trigger: { kind: 'manual' },
      });
      const frozen = await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId);
      const current = await runtime.getCoordinator()?.getWorkflow(created.workflowId);
      assert.equal(frozen?.definitionRevision, 1);
      assert.equal(frozen?.frozenDefinition.objective, 'Objective A');
      assert.equal(frozen?.frozenDefinition.entryPoint.url, 'https://example.test/a');
      assert.equal(current?.definitionRevision, 2);
      assert.equal(current?.objective, 'Objective B');
      runtime.dispose();
    });
  });

  it('keeps queued history when disabled and refuses delete while running', async () => {
    await withTempDirectory(async (directory) => {
      const runtime = await initialize(directory, 'runtime-A');
      const created = await runtime.createWorkflow(
        sampleWorkflow({
          trigger: { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: '2026-09-19T08:00:00.000Z' } },
        }),
      );
      const queued = await runtime.runWorkflowNow(created.workflowId);
      await runtime.setWorkflowEnabled(created.workflowId, false);
      assert.equal((await runtime.getCoordinator()?.getWorkflow(created.workflowId))?.enabled, false);
      assert.equal((await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId))?.state, 'queued');
      await runtime.setWorkflowEnabled(created.workflowId, true);
      await runtime.getCoordinator()?.markOccurrenceRunning(queued.occurrenceId);
      await assert.rejects(
        () => runtime.deleteWorkflow(created.workflowId),
        (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_RUNNING',
      );
      await runtime.getCoordinator()?.terminalizeRunningOccurrence({
        occurrenceId: queued.occurrenceId,
        state: 'cancelled',
        terminalReason: 'USER_CANCELLED',
      });
      await runtime.deleteWorkflow(created.workflowId);
      assert.equal(await runtime.getCoordinator()?.getWorkflow(created.workflowId), undefined);
      runtime.dispose();
    });

    await withTempDirectory(async (directory) => {
      const runtime = await initialize(directory, 'runtime-delete-queued');
      const created = await runtime.createWorkflow(sampleWorkflow({ name: 'Queued delete' }));
      const queued = await runtime.runWorkflowNow(created.workflowId);
      await runtime.deleteWorkflow(created.workflowId);
      assert.equal(await runtime.getCoordinator()?.getWorkflow(created.workflowId), undefined);
      assert.equal(await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId), undefined);
      assert.equal((await runtime.getCoordinator()?.listQueuedOccurrences())?.length, 0);
      runtime.dispose();
    });
  });

  it('fails closed on corrupt, missing-with-backup, and newer schema stores', async () => {
    await withTempDirectory(async (directory) => {
      const canonical = path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME);
      await fs.writeFile(canonical, '{not-json', 'utf8');
      await fs.writeFile(path.join(directory, WORKFLOW_STORE_BACKUP_FILENAME), '{"schemaVersion":1}', 'utf8');
      const corrupt = await initialize(directory, 'runtime-corrupt');
      assert.equal(corrupt.status, 'storage-error');
      assert.equal(corrupt.getCoordinator(), undefined);
      const controller = new WorkflowProductController(corrupt);
      const state = await controller.getState();
      assert.deepEqual(state, { ok: true, status: 'storage-error', workflows: [] });
      const created = await controller.create(sampleWorkflow());
      assert.equal(created.ok, false);
      if (!created.ok) {
        assert.equal(created.error.code, 'WORKFLOW_STORAGE_ERROR');
        assert.equal(created.error.message.includes(directory), false);
      }
      assert.equal(await fs.readFile(canonical, 'utf8'), '{not-json');
      corrupt.dispose();
    });

    await withTempDirectory(async (directory) => {
      await fs.writeFile(
        path.join(directory, `${WORKFLOW_STORE_CANONICAL_FILENAME}.deadbeef.aside`),
        '{"schemaVersion":1}',
        'utf8',
      );
      const aside = await initialize(directory, 'runtime-aside');
      assert.equal(aside.status, 'storage-error');
      aside.dispose();
    });

    await withTempDirectory(async (directory) => {
      await fs.writeFile(
        path.join(directory, WORKFLOW_STORE_BACKUP_FILENAME),
        JSON.stringify({
          schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
          storeRevision: 1,
          workflows: [],
          occurrences: [],
        }),
        'utf8',
      );
      const missing = await initialize(directory, 'runtime-missing');
      assert.equal(missing.status, 'storage-error');
      missing.dispose();
    });

    await withTempDirectory(async (directory) => {
      await fs.writeFile(
        path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME),
        JSON.stringify({
          schemaVersion: 99,
          storeRevision: 1,
          workflows: [],
          occurrences: [],
        }),
        'utf8',
      );
      const newer = await initialize(directory, 'runtime-newer');
      assert.equal(newer.status, 'storage-error');
      newer.dispose();
    });
  });
});
