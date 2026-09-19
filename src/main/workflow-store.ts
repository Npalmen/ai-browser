import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { fsyncDirectoryBestEffort, replaceFileAtomically, type FileReplacer } from './atomic-file-replace';
import { WorkflowStoreError } from '../workflows/workflow-store-errors';
import {
  cloneWorkflowStoreSnapshot,
  parseWorkflowStoreJson,
  parseWorkflowStorePayload,
  serializeWorkflowStoreSnapshot,
} from '../workflows/workflow-store-schema';
import {
  EMPTY_WORKFLOW_STORE_SNAPSHOT,
  MAX_WORKFLOW_STORE_BYTES,
  WORKFLOW_STORE_SCHEMA_VERSION,
  type WorkflowStoreMutation,
  type WorkflowStoreSnapshot,
} from '../workflows/workflow-store-types';

export const WORKFLOW_STORE_CANONICAL_FILENAME = 'workflows-v1.json';
export const WORKFLOW_STORE_BACKUP_FILENAME = 'workflows-v1.last-known-good.json';

const TEMP_SUFFIX = '.tmp';
const ASIDE_SUFFIX = '.aside';

export function isWorkflowStoreTemporaryArtifact(name: string): boolean {
  return (
    isOwnedTempOrAside(name, WORKFLOW_STORE_CANONICAL_FILENAME) ||
    isOwnedTempOrAside(name, WORKFLOW_STORE_BACKUP_FILENAME)
  );
}

export function isCanonicalRecoveryAside(name: string): boolean {
  return isOwnedNamedArtifact(name, WORKFLOW_STORE_CANONICAL_FILENAME, ASIDE_SUFFIX);
}

export interface AtomicJsonWorkflowStoreOptions {
  readonly directory: string;
  readonly maxBytes?: number;
  readonly replaceFile?: FileReplacer;
}

export class AtomicJsonWorkflowStore {
  private readonly directory: string;
  private readonly canonicalPath: string;
  private readonly backupPath: string;
  private readonly maxBytes: number;
  private readonly replaceFile: FileReplacer;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private chain: Promise<void> = Promise.resolve();
  private cached: WorkflowStoreSnapshot | undefined;

  constructor(options: AtomicJsonWorkflowStoreOptions) {
    this.directory = options.directory;
    this.canonicalPath = path.join(options.directory, WORKFLOW_STORE_CANONICAL_FILENAME);
    this.backupPath = path.join(options.directory, WORKFLOW_STORE_BACKUP_FILENAME);
    this.maxBytes = options.maxBytes ?? MAX_WORKFLOW_STORE_BYTES;
    this.replaceFile = options.replaceFile ?? replaceFileAtomically;
  }

  load(): Promise<WorkflowStoreSnapshot> {
    return this.enqueue(async () => cloneWorkflowStoreSnapshot(await this.readAuthoritativeSnapshot()));
  }

  commit(
    expectedStoreRevision: number,
    mutation: WorkflowStoreMutation,
  ): Promise<WorkflowStoreSnapshot> {
    return this.enqueue(async () => {
      const current = await this.readAuthoritativeSnapshot();
      if (expectedStoreRevision !== current.storeRevision) {
        throw new WorkflowStoreError(
          'WORKFLOW_STORE_REVISION_CONFLICT',
          'Workflow store revision conflict.',
        );
      }

      let payload;
      try {
        payload = mutation(cloneWorkflowStoreSnapshot(current));
      } catch (error) {
        if (error instanceof WorkflowStoreError) {
          throw error;
        }
        throw error;
      }

      let parsedPayload;
      try {
        parsedPayload = parseWorkflowStorePayload(payload);
      } catch (error) {
        if (error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_MUTATION_INVALID') {
          throw error;
        }
        throw new WorkflowStoreError(
          'WORKFLOW_STORE_MUTATION_INVALID',
          'Workflow store mutation is invalid.',
          { cause: error },
        );
      }

      const next: WorkflowStoreSnapshot = {
        schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
        storeRevision: current.storeRevision + 1,
        workflows: parsedPayload.workflows,
        occurrences: parsedPayload.occurrences,
      };

      const serialized = serializeWorkflowStoreSnapshot(next);
      const bytes = Buffer.from(serialized, 'utf8');
      if (bytes.byteLength > this.maxBytes) {
        throw new WorkflowStoreError(
          'WORKFLOW_STORE_TOO_LARGE',
          'Workflow store exceeds the size limit.',
        );
      }

      parseWorkflowStoreJson(serialized, 'WORKFLOW_STORE_MUTATION_INVALID');
      await this.persistCanonical(bytes);
      this.cached = cloneWorkflowStoreSnapshot(next);
      return cloneWorkflowStoreSnapshot(this.cached);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAuthoritativeSnapshot(): Promise<WorkflowStoreSnapshot> {
    if (this.cached !== undefined) {
      return this.cached;
    }

    const snapshot = await this.readCanonicalFromDisk();
    this.cached = snapshot;
    return snapshot;
  }

  private async readCanonicalFromDisk(): Promise<WorkflowStoreSnapshot> {
    let stats;
    try {
      stats = await fs.stat(this.canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (await this.hasPriorStoreEvidence()) {
          throw new WorkflowStoreError(
            'WORKFLOW_STORE_IO_FAILED',
            'Workflow store canonical file is missing.',
          );
        }
        return cloneWorkflowStoreSnapshot(EMPTY_WORKFLOW_STORE_SNAPSHOT);
      }
      throw wrapIo(error);
    }

    if (!stats.isFile()) {
      throw new WorkflowStoreError('WORKFLOW_STORE_IO_FAILED', 'Workflow store path is not a file.');
    }
    if (stats.size > this.maxBytes) {
      throw new WorkflowStoreError('WORKFLOW_STORE_TOO_LARGE', 'Workflow store exceeds the size limit.');
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(this.canonicalPath);
    } catch (error) {
      throw wrapIo(error);
    }

    if (buffer.byteLength > this.maxBytes) {
      throw new WorkflowStoreError('WORKFLOW_STORE_TOO_LARGE', 'Workflow store exceeds the size limit.');
    }

    let text: string;
    try {
      text = this.decoder.decode(buffer);
    } catch (error) {
      throw new WorkflowStoreError('WORKFLOW_STORE_CORRUPT', 'Workflow store is corrupt.', {
        cause: error,
      });
    }

    return parseWorkflowStoreJson(text, 'WORKFLOW_STORE_CORRUPT');
  }

  private async persistCanonical(bytes: Buffer): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const tempPath = path.join(this.directory, `${WORKFLOW_STORE_CANONICAL_FILENAME}.${randomUUID()}.tmp`);

    try {
      await writeFileFsynced(tempPath, bytes);
      await this.persistBackupIfCanonicalExists();
      await this.replaceFile(tempPath, this.canonicalPath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      if (error instanceof WorkflowStoreError) {
        throw error;
      }
      throw wrapIo(error);
    }

    // Directory fsync is best-effort and must not contradict a completed replace.
    await fsyncDirectoryBestEffort(this.directory).catch(() => undefined);
    await this.cleanupStaleTempFiles();
  }

  private async persistBackupIfCanonicalExists(): Promise<void> {
    let canonicalBytes: Buffer;
    try {
      canonicalBytes = await fs.readFile(this.canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw wrapIo(error);
    }

    const backupTempPath = path.join(
      this.directory,
      `${WORKFLOW_STORE_BACKUP_FILENAME}.${randomUUID()}.tmp`,
    );
    try {
      await writeFileFsynced(backupTempPath, canonicalBytes);
      await this.replaceFile(backupTempPath, this.backupPath);
    } catch (error) {
      await fs.unlink(backupTempPath).catch(() => undefined);
      throw wrapIo(error);
    }
  }

  private async hasPriorStoreEvidence(): Promise<boolean> {
    try {
      await fs.lstat(this.backupPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw wrapIo(error);
      }
    }

    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw wrapIo(error);
    }
    return entries.some((name) => isCanonicalRecoveryAside(name));
  }

  private async cleanupStaleTempFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((name) => isWorkflowStoreTemporaryArtifact(name))
        .map((name) => fs.unlink(path.join(this.directory, name)).catch(() => undefined)),
    );
  }
}

function isOwnedTempOrAside(name: string, baseFileName: string): boolean {
  return (
    isOwnedNamedArtifact(name, baseFileName, TEMP_SUFFIX) ||
    isOwnedNamedArtifact(name, baseFileName, ASIDE_SUFFIX)
  );
}

function isOwnedNamedArtifact(name: string, baseFileName: string, suffix: string): boolean {
  const prefix = `${baseFileName}.`;
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
    return false;
  }
  const middle = name.slice(prefix.length, name.length - suffix.length);
  return middle.length > 0 && !middle.includes('/') && !middle.includes('\\') && !middle.includes('\0');
}

async function writeFileFsynced(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(filePath, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function wrapIo(error: unknown): WorkflowStoreError {
  if (error instanceof WorkflowStoreError) {
    return error;
  }
  return new WorkflowStoreError('WORKFLOW_STORE_IO_FAILED', 'Workflow store I/O failed.', {
    cause: error,
  });
}
