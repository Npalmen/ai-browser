import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TaskTabStateRegistry } from './task-tab-state-registry';

describe('TaskTabStateRegistry', () => {
  it('starts owned tabs at generation 1', () => {
    const registry = new TaskTabStateRegistry();
    const snapshot = registry.initializeOwnedTab('task-1', 'task-tab-1', 'tab-a');
    assert.equal(snapshot.stateGeneration, 1);
    assert.equal(snapshot.token, 'task-tab-state-v1:1');
    assert.equal(registry.getToken('task-1', 'task-tab-1'), 'task-tab-state-v1:1');
  });

  it('starts a causally adopted tab at generation 1 independently', () => {
    const registry = new TaskTabStateRegistry();
    registry.initializeOwnedTab('task-1', 'task-tab-1', 'tab-a');
    const adopted = registry.initializeOwnedTab('task-1', 'task-tab-2', 'tab-c');
    assert.equal(adopted.stateGeneration, 1);
    assert.equal(adopted.token, 'task-tab-state-v1:1');
  });

  it('increments on main-frame navigation of an owned tab', () => {
    const registry = new TaskTabStateRegistry();
    registry.initializeOwnedTab('task-1', 'task-tab-1', 'tab-a');
    const bumped = registry.incrementForTab('tab-a');
    assert.equal(bumped?.stateGeneration, 2);
    assert.equal(registry.getToken('task-1', 'task-tab-1'), 'task-tab-state-v1:2');
  });

  it('does not increment unowned tabs', () => {
    const registry = new TaskTabStateRegistry();
    assert.equal(registry.incrementForTab('tab-x'), undefined);
  });

  it('releases tracking when a tab is released', () => {
    const registry = new TaskTabStateRegistry();
    registry.initializeOwnedTab('task-1', 'task-tab-1', 'tab-a');
    registry.releaseTab('tab-a');
    assert.equal(registry.getToken('task-1', 'task-tab-1'), undefined);
    assert.equal(registry.getByTabId('tab-a'), undefined);
  });
});
