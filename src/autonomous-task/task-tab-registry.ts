import type { TabId } from '../shared/browser-types';
import { AutonomousTaskError } from './autonomous-task-errors';
import type { AutonomousTaskId } from './autonomous-task-types';

export type TaskTabAlias = string;

export type TaskTabOwnershipKind = 'adopted' | 'task-created';

export interface TaskTabSnapshot {
  readonly taskId: AutonomousTaskId;
  readonly alias: TaskTabAlias;
  readonly tabId: TabId;
  readonly ownershipKind: TaskTabOwnershipKind;
}

interface TaskTabRecord {
  taskId: AutonomousTaskId;
  alias: TaskTabAlias;
  tabId: TabId;
  ownershipKind: TaskTabOwnershipKind;
}

interface TaskMembership {
  nextAliasIndex: number;
  readonly byAlias: Map<TaskTabAlias, TaskTabRecord>;
  readonly byTabId: Map<TabId, TaskTabRecord>;
}

export class TaskTabRegistry {
  private readonly byTabId = new Map<TabId, TaskTabRecord>();
  private readonly byTaskId = new Map<AutonomousTaskId, TaskMembership>();

  adoptStartingTab(taskId: AutonomousTaskId, tabId: TabId): TaskTabSnapshot {
    requireTaskId(taskId);
    const validatedTabId = requireTabId(tabId);
    const existing = this.byTabId.get(validatedTabId);
    if (existing !== undefined) {
      if (existing.taskId !== taskId) {
        throw new AutonomousTaskError(
          'TASK_TAB_ALREADY_OWNED',
          `Tab ${validatedTabId} already belongs to another task.`,
        );
      }
      return toTabSnapshot(existing);
    }
    const membership = this.getOrCreateMembership(taskId);
    if (membership.byTabId.size > 0) {
      throw new AutonomousTaskError(
        'TASK_TAB_ALREADY_OWNED',
        `Task ${taskId} already owns a starting tab.`,
      );
    }
    return this.installTab(membership, taskId, validatedTabId, 'adopted');
  }

  adoptTab(
    taskId: AutonomousTaskId,
    tabId: TabId,
    ownershipKind: TaskTabOwnershipKind,
  ): TaskTabSnapshot {
    requireTaskId(taskId);
    const validatedTabId = requireTabId(tabId);
    const existing = this.byTabId.get(validatedTabId);
    if (existing !== undefined) {
      if (existing.taskId !== taskId) {
        throw new AutonomousTaskError(
          'TASK_TAB_ALREADY_OWNED',
          `Tab ${validatedTabId} already belongs to another task.`,
        );
      }
      return toTabSnapshot(existing);
    }
    const membership = this.getOrCreateMembership(taskId);
    if (membership.byTabId.size >= 3) {
      throw new AutonomousTaskError(
        'TASK_TAB_LIMIT_REACHED',
        `Task ${taskId} already owns the maximum number of tabs.`,
      );
    }
    return this.installTab(membership, taskId, validatedTabId, ownershipKind);
  }

  releaseTab(taskId: AutonomousTaskId, alias: TaskTabAlias): void {
    requireTaskId(taskId);
    requireAlias(alias);
    const membership = this.byTaskId.get(taskId);
    const record = membership?.byAlias.get(alias);
    if (membership === undefined || record === undefined) {
      throw new AutonomousTaskError(
        'TASK_TAB_NOT_OWNED',
        `Task ${taskId} does not own alias ${alias}.`,
      );
    }
    this.removeRecord(membership, record);
  }

  releaseTabById(taskId: AutonomousTaskId, tabId: TabId): void {
    requireTaskId(taskId);
    const validatedTabId = requireTabId(tabId);
    const membership = this.byTaskId.get(taskId);
    const record = membership?.byTabId.get(validatedTabId);
    if (membership === undefined || record === undefined) {
      throw new AutonomousTaskError(
        'TASK_TAB_NOT_OWNED',
        `Task ${taskId} does not own tab ${validatedTabId}.`,
      );
    }
    this.removeRecord(membership, record);
  }

  releaseTask(taskId: AutonomousTaskId): void {
    requireTaskId(taskId);
    const membership = this.byTaskId.get(taskId);
    if (membership === undefined) {
      return;
    }
    for (const record of [...membership.byTabId.values()]) {
      this.byTabId.delete(record.tabId);
    }
    this.byTaskId.delete(taskId);
  }

  resolveAlias(taskId: AutonomousTaskId, alias: TaskTabAlias): TaskTabSnapshot | undefined {
    requireTaskId(taskId);
    requireAlias(alias);
    const record = this.byTaskId.get(taskId)?.byAlias.get(alias);
    return record ? toTabSnapshot(record) : undefined;
  }

  getAliasForTab(taskId: AutonomousTaskId, tabId: TabId): TaskTabAlias | undefined {
    requireTaskId(taskId);
    const validatedTabId = requireTabId(tabId);
    const record = this.byTaskId.get(taskId)?.byTabId.get(validatedTabId);
    return record?.alias;
  }

  getOwnedTabs(taskId: AutonomousTaskId): ReadonlyArray<TaskTabSnapshot> {
    requireTaskId(taskId);
    const membership = this.byTaskId.get(taskId);
    if (membership === undefined) {
      return Object.freeze([]);
    }
    return Object.freeze([...membership.byTabId.values()].map((record) => toTabSnapshot(record)));
  }

  getOwner(tabId: TabId): TaskTabSnapshot | undefined {
    const validatedTabId = requireTabId(tabId);
    const record = this.byTabId.get(validatedTabId);
    return record ? toTabSnapshot(record) : undefined;
  }

  countOwnedTabs(taskId: AutonomousTaskId): number {
    requireTaskId(taskId);
    return this.byTaskId.get(taskId)?.byTabId.size ?? 0;
  }

  clear(): void {
    this.byTabId.clear();
    this.byTaskId.clear();
  }

  private getOrCreateMembership(taskId: AutonomousTaskId): TaskMembership {
    const existing = this.byTaskId.get(taskId);
    if (existing !== undefined) {
      return existing;
    }
    const created: TaskMembership = {
      nextAliasIndex: 1,
      byAlias: new Map(),
      byTabId: new Map(),
    };
    this.byTaskId.set(taskId, created);
    return created;
  }

  private installTab(
    membership: TaskMembership,
    taskId: AutonomousTaskId,
    tabId: TabId,
    ownershipKind: TaskTabOwnershipKind,
  ): TaskTabSnapshot {
    const alias = `task-tab-${membership.nextAliasIndex}`;
    membership.nextAliasIndex += 1;
    const record: TaskTabRecord = {
      taskId,
      alias,
      tabId,
      ownershipKind,
    };
    membership.byAlias.set(alias, record);
    membership.byTabId.set(tabId, record);
    this.byTabId.set(tabId, record);
    return toTabSnapshot(record);
  }

  private removeRecord(membership: TaskMembership, record: TaskTabRecord): void {
    membership.byAlias.delete(record.alias);
    membership.byTabId.delete(record.tabId);
    this.byTabId.delete(record.tabId);
  }
}

function toTabSnapshot(record: TaskTabRecord): TaskTabSnapshot {
  return Object.freeze({
    taskId: record.taskId,
    alias: record.alias,
    tabId: record.tabId,
    ownershipKind: record.ownershipKind,
  });
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

function requireAlias(alias: TaskTabAlias): TaskTabAlias {
  if (typeof alias !== 'string' || alias.trim().length === 0) {
    throw new AutonomousTaskError(
      'INVALID_TASK_TAB_ALIAS',
      'taskTabAlias must be a non-empty string.',
    );
  }
  return alias;
}
