import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutonomousTaskError, type AutonomousTaskErrorCode } from './autonomous-task-errors';
import { TaskTabRegistry } from './task-tab-registry';

function assertTaskError(fn: () => unknown, code: AutonomousTaskErrorCode): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AutonomousTaskError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('TaskTabRegistry', () => {
  it('assigns monotonic task-local aliases starting at task-tab-1', () => {
    const registry = new TaskTabRegistry();
    const first = registry.adoptStartingTab('task-a', 'tab-a');
    const second = registry.adoptTab('task-a', 'tab-b', 'task-created');
    const third = registry.adoptTab('task-a', 'tab-c', 'adopted');

    assert.equal(first.alias, 'task-tab-1');
    assert.equal(first.ownershipKind, 'adopted');
    assert.equal(second.alias, 'task-tab-2');
    assert.equal(second.ownershipKind, 'task-created');
    assert.equal(third.alias, 'task-tab-3');
    assert.equal(registry.countOwnedTabs('task-a'), 3);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(registry.resolveAlias('task-a', 'task-tab-2')?.tabId, 'tab-b');
    assert.equal(registry.getAliasForTab('task-a', 'tab-c'), 'task-tab-3');
    assert.equal(registry.getOwner('tab-a')?.taskId, 'task-a');
  });

  it('returns the existing snapshot for same-task duplicate adoption without a new alias', () => {
    const registry = new TaskTabRegistry();
    const first = registry.adoptStartingTab('task-a', 'tab-a');
    const againStarting = registry.adoptStartingTab('task-a', 'tab-a');
    const second = registry.adoptTab('task-a', 'tab-b', 'task-created');
    const againSecond = registry.adoptTab('task-a', 'tab-b', 'adopted');

    assert.deepEqual(againStarting, first);
    assert.deepEqual(againSecond, second);
    assert.equal(second.alias, 'task-tab-2');
    assert.equal(againSecond.ownershipKind, 'task-created');
    assert.equal(registry.countOwnedTabs('task-a'), 2);
  });

  it('rejects cross-task ownership of the same tab', () => {
    const registry = new TaskTabRegistry();
    registry.adoptStartingTab('task-a', 'tab-a');
    assertTaskError(() => registry.adoptStartingTab('task-b', 'tab-a'), 'TASK_TAB_ALREADY_OWNED');
    assertTaskError(
      () => registry.adoptTab('task-b', 'tab-a', 'adopted'),
      'TASK_TAB_ALREADY_OWNED',
    );
    assert.equal(registry.getOwner('tab-a')?.taskId, 'task-a');
    assert.equal(registry.countOwnedTabs('task-b'), 0);
  });

  it('never reuses a released alias inside the same task', () => {
    const registry = new TaskTabRegistry();
    registry.adoptStartingTab('task-a', 'tab-a');
    registry.adoptTab('task-a', 'tab-b', 'task-created');
    registry.adoptTab('task-a', 'tab-c', 'task-created');
    registry.releaseTab('task-a', 'task-tab-2');

    assert.equal(registry.resolveAlias('task-a', 'task-tab-2'), undefined);
    assert.equal(registry.getOwner('tab-b'), undefined);
    assert.equal(registry.countOwnedTabs('task-a'), 2);

    const next = registry.adoptTab('task-a', 'tab-d', 'task-created');
    assert.equal(next.alias, 'task-tab-4');
    assert.notEqual(next.alias, 'task-tab-2');
  });

  it('enforces the concurrent owned-tab limit without mutating membership', () => {
    const registry = new TaskTabRegistry();
    registry.adoptStartingTab('task-a', 'tab-1');
    registry.adoptTab('task-a', 'tab-2', 'task-created');
    registry.adoptTab('task-a', 'tab-3', 'task-created');
    assertTaskError(
      () => registry.adoptTab('task-a', 'tab-4', 'task-created'),
      'TASK_TAB_LIMIT_REACHED',
    );
    assert.equal(registry.countOwnedTabs('task-a'), 3);
    assert.equal(registry.getOwner('tab-4'), undefined);
    assert.equal(registry.resolveAlias('task-a', 'task-tab-4'), undefined);
  });

  it('releaseTask clears membership so old aliases no longer resolve', () => {
    const registry = new TaskTabRegistry();
    registry.adoptStartingTab('task-a', 'tab-a');
    registry.adoptTab('task-a', 'tab-b', 'task-created');
    registry.releaseTask('task-a');
    assert.equal(registry.countOwnedTabs('task-a'), 0);
    assert.equal(registry.resolveAlias('task-a', 'task-tab-1'), undefined);
    assert.equal(registry.getOwner('tab-a'), undefined);
    assert.deepEqual(registry.getOwnedTabs('task-a'), []);
  });

  it('returns immutable owned-tab snapshots', () => {
    const registry = new TaskTabRegistry();
    registry.adoptStartingTab('task-a', 'tab-a');
    const owned = registry.getOwnedTabs('task-a');
    assert.equal(Object.isFrozen(owned), true);
    assert.equal(Object.isFrozen(owned[0]), true);
    assert.throws(() => {
      (owned as unknown as { alias: string }[]).push(owned[0]);
    });
  });
});
