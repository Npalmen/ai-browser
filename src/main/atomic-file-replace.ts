import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type FileReplacer = (tempPath: string, destinationPath: string) => Promise<void>;

/**
 * Replace `destinationPath` with a same-directory temp file.
 *
 * Never writes destination contents in place. On Windows, `fs.rename` cannot
 * overwrite an existing destination; the helper moves the destination aside,
 * then renames the temp into place, restoring the aside file if the second
 * rename fails. That creates a brief destination-missing window, which is
 * acceptable only under the WorkflowStore single-writer assumption.
 */
export async function replaceFileAtomically(
  tempPath: string,
  destinationPath: string,
): Promise<void> {
  assertSameDirectory(tempPath, destinationPath);

  try {
    await fs.rename(tempPath, destinationPath);
    return;
  } catch (error) {
    if (!(await pathExists(destinationPath))) {
      throw error;
    }
  }

  const asidePath = `${destinationPath}.${randomUUID()}.aside`;
  await fs.rename(destinationPath, asidePath);
  try {
    await fs.rename(tempPath, destinationPath);
  } catch (error) {
    try {
      await fs.rename(asidePath, destinationPath);
    } catch {
      // Restore failed; the previous destination bytes may remain at asidePath.
    }
    throw error;
  }
  await fs.unlink(asidePath).catch(() => undefined);
}

/**
 * Best-effort directory fsync after a successful replace.
 *
 * Ignored error class (directory fsync is not portable):
 * EPERM, EACCES, EINVAL, EISDIR, ENOTSUP, EBADF.
 * Canonical file write/fsync/replace failures must not use this helper.
 */
export async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isIgnorableDirectoryFsyncError(error)) {
      return;
    }
    throw error;
  }
}

export function isIgnorableDirectoryFsyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EINVAL' ||
    code === 'EISDIR' ||
    code === 'ENOTSUP' ||
    code === 'EBADF'
  );
}

function assertSameDirectory(tempPath: string, destinationPath: string): void {
  if (path.dirname(path.resolve(tempPath)) !== path.dirname(path.resolve(destinationPath))) {
    throw new Error('Atomic replace requires a same-directory temp file.');
  }
}

async function pathExists(filePath: string): Promise<boolean> {
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
