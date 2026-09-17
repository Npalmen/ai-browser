import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BrowserTab } from '../shared/browser-types';
import { TabNotFoundError, TabRegistry } from './tab-registry';

function makeTab(id: string): BrowserTab {
  return {
    id,
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

describe('TabRegistry', () => {
  it('adds tabs and activates the most recently added tab', () => {
    const registry = new TabRegistry();

    registry.addTab(makeTab('a'));
    assert.equal(registry.getActiveTabId(), 'a');

    registry.addTab(makeTab('b'));
    assert.equal(registry.getActiveTabId(), 'b');

    registry.activateTab('a');
    assert.equal(registry.getActiveTabId(), 'a');
  });

  it('fails closed for unknown tab ids', () => {
    const registry = new TabRegistry();
    registry.addTab(makeTab('a'));

    assert.throws(() => registry.getTab('missing'), TabNotFoundError);
    assert.throws(() => registry.activateTab('missing'), TabNotFoundError);
    assert.throws(() => registry.removeTab('missing'), TabNotFoundError);
  });

  it('closes the active tab by preferring the right neighbor', () => {
    const registry = new TabRegistry();
    registry.addTab(makeTab('a'));
    registry.addTab(makeTab('b'));
    registry.addTab(makeTab('c'));
    registry.activateTab('b');

    const next = registry.removeTab('b');

    assert.equal(next, 'c');
    assert.equal(registry.getActiveTabId(), 'c');
    assert.deepEqual(registry.serialize().tabs.map((tab) => tab.id), ['a', 'c']);
  });

  it('returns null when the final tab is removed', () => {
    const registry = new TabRegistry();
    registry.addTab(makeTab('only'));

    const next = registry.removeTab('only');

    assert.equal(next, null);
    assert.throws(() => registry.serialize(), /No active tab/);
  });

  it('serializes ordered tabs and active tab id', () => {
    const registry = new TabRegistry();
    registry.addTab(makeTab('a'));
    registry.addTab(makeTab('b'));
    registry.activateTab('a');

    const state = registry.serialize();

    assert.deepEqual(state.tabs.map((tab) => tab.id), ['a', 'b']);
    assert.equal(state.activeTabId, 'a');
    assert.notEqual(state.tabs[0], registry.getTab('a'));
  });
});
