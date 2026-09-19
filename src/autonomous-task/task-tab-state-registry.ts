import type { TabId } from '../shared/browser-types';
import { AutonomousTaskError } from './autonomous-task-errors';
import type { AutonomousTaskId } from './autonomous-task-types';

export const TASK_TAB_STATE_TOKEN_PREFIX = 'task-tab-state-v1:';

export interface TaskTabStateSnapshot {
  readonly taskId: AutonomousTaskId;
  readonly alias: string;
  readonly tabId: TabId;
  readonly stateGeneration: number;
  readonly token: string;
}

interface TaskTabStateRecord {
  taskId: AutonomousTaskId;
  alias: string;
  tabId: TabId;
  stateGeneration: number;
}

/**
 * Trusted-main task-tab lifecycle generations. Not model, renderer, or
 * browser authority. Used only to derive no-progress fingerprints.
 */
export class TaskTabStateRegistry {
  private readonly byTabId = new Map<TabId, TaskTabStateRecord>();
  private readonly byTaskAlias = new Map<string, TaskTabStateRecord>();

  initializeOwnedTab(taskId: AutonomousTaskId, alias: string, tabId: TabId): TaskTabStateSnapshot {
    requireTaskId(taskId);
    requireAlias(alias);
    const validatedTabId = requireTabId(tabId);
    const existing = this.byTabId.get(validatedTabId);
    if (existing !== undefined) {
      if (existing.taskId !== taskId || existing.alias !== alias) {
        throw new AutonomousTaskError(
          'TASK_TAB_ALREADY_OWNED',
          `Tab ${validatedTabId} already has task-tab state tracking.`,
        );
      }
      return toSnapshot(existing);
    }
    const record: TaskTabStateRecord = {
      taskId,
      alias,
      tabId: validatedTabId,
      stateGeneration: 1,
    };
    this.byTabId.set(validatedTabId, record);
    this.byTaskAlias.set(aliasKey(taskId, alias), record);
    return toSnapshot(record);
  }

  getToken(taskId: AutonomousTaskId, alias: string): string | undefined {
    requireTaskId(taskId);
    requireAlias(alias);
    const record = this.byTaskAlias.get(aliasKey(taskId, alias));
    return record ? toToken(record.stateGeneration) : undefined;
  }

  getByTabId(tabId: TabId): TaskTabStateSnapshot | undefined {
    const record = this.byTabId.get(requireTabId(tabId));
    return record ? toSnapshot(record) : undefined;
  }

  incrementForTab(tabId: TabId): TaskTabStateSnapshot | undefined {
    const record = this.byTabId.get(requireTabId(tabId));
    if (record === undefined) {
      return undefined;
    }
    record.stateGeneration += 1;
    return toSnapshot(record);
  }

  incrementForAlias(taskId: AutonomousTaskId, alias: string): TaskTabStateSnapshot | undefined {
    requireTaskId(taskId);
    requireAlias(alias);
    const record = this.byTaskAlias.get(aliasKey(taskId, alias));
    if (record === undefined) {
      return undefined;
    }
    record.stateGeneration += 1;
    return toSnapshot(record);
  }

  releaseTab(tabId: TabId): void {
    const record = this.byTabId.get(requireTabId(tabId));
    if (record === undefined) {
      return;
    }
    this.byTabId.delete(record.tabId);
    this.byTaskAlias.delete(aliasKey(record.taskId, record.alias));
  }

  releaseTask(taskId: AutonomousTaskId): void {
    requireTaskId(taskId);
    for (const record of [...this.byTabId.values()]) {
      if (record.taskId === taskId) {
        this.byTabId.delete(record.tabId);
        this.byTaskAlias.delete(aliasKey(record.taskId, record.alias));
      }
    }
  }

  clear(): void {
    this.byTabId.clear();
    this.byTaskAlias.clear();
  }
}

function toToken(generation: number): string {
  return `${TASK_TAB_STATE_TOKEN_PREFIX}${generation}`;
}

function toSnapshot(record: TaskTabStateRecord): TaskTabStateSnapshot {
  return Object.freeze({
    taskId: record.taskId,
    alias: record.alias,
    tabId: record.tabId,
    stateGeneration: record.stateGeneration,
    token: toToken(record.stateGeneration),
  });
}

function aliasKey(taskId: AutonomousTaskId, alias: string): string {
  return `${taskId}:${alias}`;
}

function requireTaskId(taskId: AutonomousTaskId): AutonomousTaskId {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    throw new AutonomousTaskError(
      'INVALID_AUTONOMOUS_TASK_ID',
      'taskId must be a non-empty string.',
    );
  }
  return taskId;
}

function requireTabId(tabId: TabId): TabId {
  if (typeof tabId !== 'string' || tabId.trim().length === 0) {
    throw new AutonomousTaskError('INVALID_TAB_ID', 'tabId must be a non-empty string.');
  }
  return tabId;
}

function requireAlias(alias: string): string {
  if (typeof alias !== 'string' || alias.trim().length === 0) {
    throw new AutonomousTaskError(
      'INVALID_TASK_TAB_ALIAS',
      'taskTabAlias must be a non-empty string.',
    );
  }
  return alias;
}
