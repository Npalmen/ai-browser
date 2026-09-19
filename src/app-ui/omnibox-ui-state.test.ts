import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_CONTEXT_TABS } from '../shared/ai-native-types';
import type { BrowserTab } from '../shared/browser-types';
import {
  closeContextPicker,
  contextSummary,
  defaultContextForCapability,
  draftFromUrl,
  emptyOmniboxState,
  handleEscape,
  isAskAvailableForTab,
  isExecutableCapability,
  OMNIBOX_PHASE_UNAVAILABLE,
  reconcileWithBrowser,
  selectCapability,
  setContextMode,
  setPhaseUnavailable,
  syncDraftFromUrl,
  toggleContextPicker,
  toggleSelectedTab,
} from './omnibox-ui-state';

function tab(id: string, url: string, title?: string): BrowserTab {
  return {
    id,
    url,
    title: title ?? id,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

describe('omnibox-ui-state', () => {
  it('starts in default capability with empty draft', () => {
    const state = emptyOmniboxState();
    assert.equal(state.capability, 'default');
    assert.equal(state.draft, '');
    assert.equal(state.context, null);
    assert.equal(state.contextPickerOpen, false);
  });

  it('syncs draft from page URL and clears about:blank', () => {
    assert.equal(draftFromUrl('about:blank'), '');
    let state = syncDraftFromUrl(emptyOmniboxState(), 'https://example.com/page');
    assert.equal(state.draft, 'https://example.com/page');
    state = { ...state, isEditing: true };
    state = syncDraftFromUrl(state, 'https://example.com/other');
    assert.equal(state.draft, 'https://example.com/page');
  });

  it('selects ask with current-tab for http tabs and clears context for about:blank', () => {
    const httpTab = tab('tab-a', 'https://example.com/a');
    const blankTab = tab('tab-b', 'about:blank');
    const askState = selectCapability(emptyOmniboxState(), 'ask', httpTab);
    assert.equal(askState.capability, 'ask');
    assert.deepEqual(askState.context, { kind: 'current-tab', tabId: 'tab-a' });
    assert.equal(isAskAvailableForTab(blankTab), false);
    const blankAsk = selectCapability(emptyOmniboxState(), 'ask', blankTab);
    assert.equal(blankAsk.context, null);
  });

  it('clears context when switching away from ask/automate', () => {
    const httpTab = tab('tab-a', 'https://example.com/a');
    const askState = selectCapability(emptyOmniboxState(), 'ask', httpTab);
    const searchState = selectCapability(askState, 'search', httpTab);
    assert.equal(searchState.context, null);
    assert.equal(searchState.contextPickerOpen, false);
  });

  it('follows active tab for current-tab context', () => {
    const tabs = [
      tab('tab-a', 'https://example.com/a'),
      tab('tab-c', 'https://example.com/c'),
    ];
    let state = selectCapability(emptyOmniboxState(), 'ask', tabs[0]);
    state = reconcileWithBrowser(state, tabs, 'tab-c');
    assert.deepEqual(state.context, { kind: 'current-tab', tabId: 'tab-c' });
  });

  it('preserves selected-tabs order across active tab changes', () => {
    const tabs = [
      tab('tab-a', 'https://example.com/a'),
      tab('tab-b', 'https://example.com/b'),
      tab('tab-c', 'https://example.com/c'),
    ];
    let state = selectCapability(emptyOmniboxState(), 'ask', tabs[0]);
    state = setContextMode(state, 'selected-tabs', tabs[0]);
    state = toggleSelectedTab(state, 'tab-b', tabs);
    state = toggleSelectedTab(state, 'tab-a', tabs);
    assert.deepEqual(state.context, { kind: 'selected-tabs', tabIds: ['tab-b', 'tab-a'] });
    state = reconcileWithBrowser(state, tabs, 'tab-c');
    assert.deepEqual(state.context, { kind: 'selected-tabs', tabIds: ['tab-b', 'tab-a'] });
  });

  it('prunes closed selected tabs', () => {
    const tabs = [
      tab('tab-a', 'https://example.com/a'),
      tab('tab-b', 'https://example.com/b'),
    ];
    let state = selectCapability(emptyOmniboxState(), 'ask', tabs[0]);
    state = setContextMode(state, 'selected-tabs', tabs[0]);
    state = toggleSelectedTab(state, 'tab-a', tabs);
    state = toggleSelectedTab(state, 'tab-b', tabs);
    state = reconcileWithBrowser(state, [tabs[0]], 'tab-a');
    assert.deepEqual(state.context, { kind: 'selected-tabs', tabIds: ['tab-a'] });
  });

  it('enforces max selected tabs', () => {
    const tabs = Array.from({ length: 6 }, (_, index) =>
      tab(`tab-${index}`, `https://example.com/${index}`),
    );
    let state = selectCapability(emptyOmniboxState(), 'ask', tabs[0]);
    state = setContextMode(state, 'selected-tabs', tabs[0]);
    for (const candidate of tabs.slice(0, MAX_CONTEXT_TABS)) {
      state = toggleSelectedTab(state, candidate.id, tabs);
    }
    assert.equal(state.context?.kind, 'selected-tabs');
    if (state.context?.kind === 'selected-tabs') {
      assert.equal(state.context.tabIds.length, MAX_CONTEXT_TABS);
    }
    const blocked = toggleSelectedTab(state, tabs[MAX_CONTEXT_TABS].id, tabs);
    if (blocked.context?.kind === 'selected-tabs') {
      assert.equal(blocked.context.tabIds.length, MAX_CONTEXT_TABS);
    }
  });

  it('summarizes context selection', () => {
    const httpTab = tab('tab-a', 'https://example.com/a');
    let state = selectCapability(emptyOmniboxState(), 'ask', httpTab);
    assert.equal(contextSummary(state), 'Current tab');
    state = setContextMode(state, 'selected-tabs', httpTab);
    assert.equal(contextSummary(state), 'Select tabs');
    state = toggleSelectedTab(state, 'tab-a', [httpTab, tab('tab-b', 'https://example.com/b')]);
    state = toggleSelectedTab(state, 'tab-b', [httpTab, tab('tab-b', 'https://example.com/b')]);
    assert.equal(contextSummary(state), '2 tabs');
  });

  it('closes context picker on Escape', () => {
    const httpTab = tab('tab-a', 'https://example.com/a');
    let state = selectCapability(emptyOmniboxState(), 'ask', httpTab);
    state = toggleContextPicker(state);
    assert.equal(state.contextPickerOpen, true);
    state = handleEscape(state);
    assert.equal(state.contextPickerOpen, false);
    state = closeContextPicker(state);
    assert.equal(state.contextPickerOpen, false);
  });

  it('marks AI capabilities as non-executable in Phase 3', () => {
    assert.equal(isExecutableCapability('default'), true);
    assert.equal(isExecutableCapability('search'), true);
    assert.equal(isExecutableCapability('ask'), false);
    assert.equal(isExecutableCapability('act'), false);
    const state = setPhaseUnavailable(emptyOmniboxState());
    assert.equal(state.phaseUnavailableMessage, OMNIBOX_PHASE_UNAVAILABLE);
  });

  it('defaults automate to current-tab including about:blank', () => {
    const blankTab = tab('tab-b', 'about:blank');
    const context = defaultContextForCapability('automate', blankTab);
    assert.deepEqual(context, { kind: 'current-tab', tabId: 'tab-b' });
  });
});
