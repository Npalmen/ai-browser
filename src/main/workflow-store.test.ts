import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { replaceFileAtomically } from './atomic-file-replace';
import {
  AtomicJsonWorkflowStore,
  WORKFLOW_STORE_BACKUP_FILENAME,
  WORKFLOW_STORE_CANONICAL_FILENAME,
} from './workflow-store';
import { WorkflowStoreError } from '../workflows/workflow-store-errors';
import { parseWorkflowStoreJson } from '../workflows/workflow-store-schema';
import {
  MAX_WORKFLOW_STORE_BYTES,
  type DurableWorkflowDefinitionRecord,
  type WorkflowOccurrenceRecord,
  type WorkflowStorePayload,
  type WorkflowStoreSnapshot,
} from '../workflows/workflow-store-types';

const INSTANT = '2026-09-19T10:00:00.000Z';

describe('AtomicJsonWorkflowStore', () => {
  it('loads an empty snapshot when the canonical file is missing and does not create it', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      const snapshot = await store.load();
      assert.deepEqual(snapshot, emptySnapshot());
      assert.equal(await exists(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME)), false);
      assert.deepEqual(await fs.readdir(directory), []);
    });
  });

  it('creates canonical on first commit and reloads from a new instance', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      const committed = await store.commit(0, () => payloadWith(validWorkflow()));
      assert.equal(committed.storeRevision, 1);
      assert.equal(committed.schemaVersion, 1);
      assert.equal(await exists(path.join(directory, WORKFLOW_STORE_BACKUP_FILENAME)), false);

      const reloaded = await new AtomicJsonWorkflowStore({ directory }).load();
      assert.deepEqual(reloaded, committed);
      assert.equal(reloaded.workflows[0]?.entryPoint.url, 'https://example.com/path?resource=123');
    });
  });

  it('writes last-known-good backup of the previous canonical on the second commit', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      const first = await store.commit(0, () => payloadWith(validWorkflow('wf-a', 'A')));
      const second = await store.commit(1, () => payloadWith(validWorkflow('wf-b', 'B')));
      assert.equal(second.storeRevision, 2);
      assert.equal(second.workflows[0]?.name, 'B');

      const canonical = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME), 'utf8');
      const backup = await fs.readFile(path.join(directory, WORKFLOW_STORE_BACKUP_FILENAME), 'utf8');
      const parsedCanonical = parseWorkflowStoreJson(canonical);
      const parsedBackup = parseWorkflowStoreJson(backup);
      assert.equal(parsedCanonical.storeRevision, 2);
      assert.deepEqual(parsedCanonical, second);
      assert.equal(parsedBackup.storeRevision, 1);
      assert.deepEqual(parsedBackup, first);
    });
  });

  it('rejects an optimistic revision conflict without changing canonical bytes', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      await store.commit(0, () => payloadWith(validWorkflow()));
      const before = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME));

      await assert.rejects(
        () => store.commit(0, () => payloadWith(validWorkflow('wf-2', 'other'))),
        (error: unknown) =>
          error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_REVISION_CONFLICT',
      );

      const after = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME));
      assert.deepEqual(after, before);
      assert.equal((await store.load()).storeRevision, 1);
    });
  });

  it('serializes concurrent same-revision commits so exactly one wins', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      const results = await Promise.allSettled([
        store.commit(0, () => payloadWith(validWorkflow('wf-a', 'A'))),
        store.commit(0, () => payloadWith(validWorkflow('wf-b', 'B'))),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(
        rejected[0]?.status === 'rejected' &&
          rejected[0].reason instanceof WorkflowStoreError &&
          rejected[0].reason.code === 'WORKFLOW_STORE_REVISION_CONFLICT',
        true,
      );

      const snapshot = await store.load();
      assert.equal(snapshot.storeRevision, 1);
      assert.equal(snapshot.workflows.length, 1);
    });
  });

  it('isolates returned snapshots from later loads', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      await store.commit(0, () => payloadWith(validWorkflow()));
      const snapshot = await store.load();
      const workflows = snapshot.workflows as DurableWorkflowDefinitionRecord[];
      assert.throws(() => {
        (snapshot as { storeRevision: number }).storeRevision = 99;
      });
      assert.throws(() => {
        workflows.push(validWorkflow('wf-x', 'mutated'));
      });
      const again = await store.load();
      assert.equal(again.storeRevision, 1);
      assert.equal(again.workflows.length, 1);
      assert.equal(again.workflows[0]?.name, 'Invoice check');
    });
  });

  it('queues load behind an in-flight commit', async () => {
    await withTempDir(async (directory) => {
      let replaceStarted = false;
      let releaseReplace: () => void = () => undefined;
      const holdReplace = new Promise<void>((resolve) => {
        releaseReplace = resolve;
      });
      const store = new AtomicJsonWorkflowStore({
        directory,
        replaceFile: async (tempPath, destinationPath) => {
          replaceStarted = true;
          await holdReplace;
          await replaceFileAtomically(tempPath, destinationPath);
        },
      });

      const commitPromise = store.commit(0, () => payloadWith(validWorkflow()));
      while (!replaceStarted) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const loadPromise = store.load();
      releaseReplace();
      const loaded = await loadPromise;
      await commitPromise;
      assert.equal(loaded.storeRevision, 1);
    });
  });

  it('fails closed on corrupt canonical JSON and does not write an empty store', async () => {
    await withTempDir(async (directory) => {
      const canonical = path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME);
      await fs.writeFile(canonical, '{ this is not json\n');
      const store = new AtomicJsonWorkflowStore({ directory });
      await assert.rejects(
        () => store.load(),
        (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_CORRUPT',
      );
      assert.equal(await fs.readFile(canonical, 'utf8'), '{ this is not json\n');
    });
  });

  it('does not auto-promote a valid backup when canonical is corrupt', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      const first = await store.commit(0, () => payloadWith(validWorkflow()));
      await store.commit(1, () => payloadWith(validWorkflow('wf-2', 'second')));

      const canonical = path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME);
      const backup = path.join(directory, WORKFLOW_STORE_BACKUP_FILENAME);
      const backupBefore = await fs.readFile(backup);
      await fs.writeFile(canonical, '{ this is not json\n');

      await assert.rejects(
        () => new AtomicJsonWorkflowStore({ directory }).load(),
        (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_CORRUPT',
      );
      assert.deepEqual(await fs.readFile(backup), backupBefore);
      assert.equal(parseWorkflowStoreJson(backupBefore.toString('utf8')).storeRevision, first.storeRevision);
    });
  });

  it('rejects an unsupported schema without rewriting the file', async () => {
    await withTempDir(async (directory) => {
      const canonical = path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME);
      const raw = `${JSON.stringify({
        schemaVersion: 999,
        storeRevision: 1,
        workflows: [],
        occurrences: [],
      }, null, 2)}\n`;
      await fs.writeFile(canonical, raw);
      await assert.rejects(
        () => new AtomicJsonWorkflowStore({ directory }).load(),
        (error: unknown) =>
          error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_SCHEMA_UNSUPPORTED',
      );
      assert.equal(await fs.readFile(canonical, 'utf8'), raw);
    });
  });

  it('rejects missing and extra fields from an existing file', async () => {
    await withTempDir(async (directory) => {
      const canonical = path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME);
      await fs.writeFile(
        canonical,
        `${JSON.stringify({ schemaVersion: 1, storeRevision: 1, workflows: [] }, null, 2)}\n`,
      );
      await assert.rejects(
        () => new AtomicJsonWorkflowStore({ directory }).load(),
        (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_CORRUPT',
      );
    });
  });

  it('rejects oversized canonical files before parsing and oversized commits without writing', async () => {
    await withTempDir(async (directory) => {
      const canonical = path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME);
      await fs.writeFile(canonical, Buffer.alloc(MAX_WORKFLOW_STORE_BYTES + 1, 0x61));
      await assert.rejects(
        () => new AtomicJsonWorkflowStore({ directory }).load(),
        (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_TOO_LARGE',
      );
      assert.equal((await fs.stat(canonical)).size, MAX_WORKFLOW_STORE_BYTES + 1);
    });

    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory, maxBytes: 64 });
      await assert.rejects(
        () => store.commit(0, () => payloadWith(validWorkflow())),
        (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_TOO_LARGE',
      );
      assert.equal(await exists(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME)), false);
      assert.equal((await store.load()).storeRevision, 0);
    });
  });

  it('rejects an invalid mutation without incrementing revision or writing disk', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      await store.commit(0, () => payloadWith(validWorkflow()));
      const before = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME));
      await assert.rejects(
        () =>
          store.commit(1, () => ({
            workflows: [{ ...validWorkflow(), approvalId: 'approval-1' } as never],
            occurrences: [],
          })),
        (error: unknown) =>
          error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_MUTATION_INVALID',
      );
      const after = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME));
      assert.deepEqual(after, before);
      assert.equal((await store.load()).storeRevision, 1);
    });
  });

  it('replaces an existing canonical file on the current OS and leaves no required temp', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({ directory });
      await store.commit(0, () => payloadWith(validWorkflow('wf-1', 'one')));
      const second = await store.commit(1, () => payloadWith(validWorkflow('wf-2', 'two')));
      const canonical = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME), 'utf8');
      assert.equal(parseWorkflowStoreJson(canonical).storeRevision, 2);
      assert.equal(parseWorkflowStoreJson(canonical).workflows[0]?.name, 'two');
      const backup = await fs.readFile(path.join(directory, WORKFLOW_STORE_BACKUP_FILENAME), 'utf8');
      assert.equal(parseWorkflowStoreJson(backup).storeRevision, 1);
      const leftovers = (await fs.readdir(directory)).filter(
        (name) => name.endsWith('.tmp') || name.endsWith('.aside'),
      );
      assert.deepEqual(leftovers, []);
      assert.equal(second.storeRevision, 2);
    });
  });

  it('keeps previous canonical authoritative when replace fails before commit', async () => {
    await withTempDir(async (directory) => {
      const store = new AtomicJsonWorkflowStore({
        directory,
        replaceFile: async (tempPath, destinationPath) => {
          if (path.basename(destinationPath) === WORKFLOW_STORE_CANONICAL_FILENAME) {
            throw new Error('injected replace failure');
          }
          await replaceFileAtomically(tempPath, destinationPath);
        },
      });
      await assert.rejects(
        () => store.commit(0, () => payloadWith(validWorkflow())),
        (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_IO_FAILED',
      );
      assert.equal(await exists(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME)), false);
      assert.equal((await store.load()).storeRevision, 0);

      const durable = new AtomicJsonWorkflowStore({ directory });
      const first = await durable.commit(0, () => payloadWith(validWorkflow('wf-1', 'kept')));
      const before = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME));
      const failing = new AtomicJsonWorkflowStore({
        directory,
        replaceFile: async (tempPath, destinationPath) => {
          if (path.basename(destinationPath) === WORKFLOW_STORE_CANONICAL_FILENAME) {
            throw new Error('injected replace failure');
          }
          await replaceFileAtomically(tempPath, destinationPath);
        },
      });
      await assert.rejects(
        () => failing.commit(1, () => payloadWith(validWorkflow('wf-2', 'lost'))),
        (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_IO_FAILED',
      );
      const after = await fs.readFile(path.join(directory, WORKFLOW_STORE_CANONICAL_FILENAME));
      assert.deepEqual(after, before);
      assert.equal((await new AtomicJsonWorkflowStore({ directory }).load()).storeRevision, first.storeRevision);
    });
  });

  it('does not import browser, approval, model, or Electron runtime modules', () => {
    const source = readNearby('workflow-store.ts');
    const replaceSource = readNearby('atomic-file-replace.ts');
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
      "app.getPath",
      'requestSingleInstanceLock',
    ]) {
      assert.equal(source.includes(banned), false, banned);
      assert.equal(replaceSource.includes(banned), false, banned);
    }
  });
});

describe('replaceFileAtomically', () => {
  it('creates a destination when it does not exist and replaces when it does', async () => {
    await withTempDir(async (directory) => {
      const dest = path.join(directory, 'target.json');
      const firstTemp = path.join(directory, 'first.tmp');
      const secondTemp = path.join(directory, 'second.tmp');
      await fs.writeFile(firstTemp, 'one');
      await replaceFileAtomically(firstTemp, dest);
      assert.equal(await fs.readFile(dest, 'utf8'), 'one');

      await fs.writeFile(secondTemp, 'two');
      await replaceFileAtomically(secondTemp, dest);
      assert.equal(await fs.readFile(dest, 'utf8'), 'two');
      assert.equal(await exists(firstTemp), false);
      assert.equal(await exists(secondTemp), false);
    });
  });
});

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-store-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function payloadWith(workflow: DurableWorkflowDefinitionRecord, occurrences: WorkflowOccurrenceRecord[] = []): WorkflowStorePayload {
  return { workflows: [workflow], occurrences };
}

function emptySnapshot(): WorkflowStoreSnapshot {
  return {
    schemaVersion: 1,
    storeRevision: 0,
    workflows: [],
    occurrences: [],
  };
}

function validWorkflow(workflowId = 'wf-1', name = 'Invoice check'): DurableWorkflowDefinitionRecord {
  return {
    workflowId,
    definitionRevision: 1,
    name,
    objective: 'Open the invoice page and summarize totals.',
    entryPoint: { kind: 'url', url: 'https://example.com/path?resource=123' },
    trigger: { kind: 'manual' },
    enabled: true,
    reviewRequired: false,
    createdAt: INSTANT,
    updatedAt: INSTANT,
  };
}

function readNearby(filename: string): string {
  return readFileSync(path.join(__dirname, filename), 'utf8');
}
