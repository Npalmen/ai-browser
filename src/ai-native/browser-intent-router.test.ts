import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MAX_BROWSER_INTENT_TEXT_CHARS, MAX_SEARCH_QUERY_CHARS } from '../shared/ai-native-types';
import type { BrowserIntentRouterState } from '../shared/ai-native-types';
import { routeBrowserIntent } from './browser-intent-router';

const ROOT = path.resolve(__dirname, '..', '..');

function state(
  tabs: Array<{ id: string; url: string }>,
  activeTabId: string | null = tabs[0]?.id ?? null,
): BrowserIntentRouterState {
  return {
    activeTabId,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })),
  };
}

describe('routeBrowserIntent default routing', () => {
  const browser = state([{ id: 'tab-1', url: 'https://example.com/' }]);

  it('routes https URLs to Navigate', () => {
    const result = routeBrowserIntent(
      { text: 'https://example.com', capability: 'default' },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'navigate');
      assert.equal(result.route.url, 'https://example.com/');
    }
  });

  it('routes bare hostnames to Navigate', () => {
    const result = routeBrowserIntent({ text: 'example.com', capability: 'default' }, browser);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'navigate');
      assert.equal(result.route.url, 'https://example.com/');
    }
  });

  it('routes localhost with port to Navigate', () => {
    const result = routeBrowserIntent({ text: 'localhost:3000', capability: 'default' }, browser);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'navigate');
      assert.equal(result.route.url, 'https://localhost:3000/');
    }
  });

  it('routes about:blank to Navigate', () => {
    const result = routeBrowserIntent({ text: 'about:blank', capability: 'default' }, browser);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'navigate');
      assert.equal(result.route.url, 'about:blank');
    }
  });

  it('routes ordinary text to Search', () => {
    for (const text of ['cats', 'best laptops 2026', 'open source browser agent', 'example search']) {
      const result = routeBrowserIntent({ text, capability: 'default' }, browser);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.route.kind, 'search');
        assert.equal(result.route.query, text);
      }
    }
  });

  it('rejects empty input', () => {
    const result = routeBrowserIntent({ text: '   ', capability: 'default' }, browser);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_EMPTY_INPUT');
    }
  });

  it('fails closed for forbidden schemes', () => {
    for (const text of [
      'javascript:alert(1)',
      'file:///tmp/a',
      'data:text/html,hello',
      'blob:https://example.com/uuid',
      'chrome://settings',
      'chrome-extension://abc/page.html',
    ]) {
      const result = routeBrowserIntent({ text, capability: 'default' }, browser);
      assert.equal(result.ok, false, text);
      if (!result.ok) {
        assert.equal(result.error.code, 'AI_NATIVE_SEARCH_INVALID');
      }
    }
  });

  it('rejects oversized search queries', () => {
    const text = 'a'.repeat(MAX_SEARCH_QUERY_CHARS + 1);
    const result = routeBrowserIntent({ text, capability: 'default' }, browser);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_SEARCH_INVALID');
    }
  });

  it('rejects valid URLs longer than MAX_BROWSER_INTENT_TEXT_CHARS', () => {
    const text = `https://example.com/${'a'.repeat(MAX_BROWSER_INTENT_TEXT_CHARS)}`;
    const result = routeBrowserIntent({ text, capability: 'default' }, browser);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });

  it('rejects context on default', () => {
    const result = routeBrowserIntent(
      {
        text: 'cats',
        capability: 'default',
        context: { kind: 'current-tab', tabId: 'tab-1' },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });

  it('never returns ask, act, delegate, or draft-workflow for default', () => {
    const samples = ['cats', 'https://example.com', 'about:blank', 'example.com'];
    for (const text of samples) {
      const result = routeBrowserIntent({ text, capability: 'default' }, browser);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(result.route.kind === 'navigate' || result.route.kind === 'search');
      }
    }
  });
});

describe('routeBrowserIntent explicit Search', () => {
  const browser = state([{ id: 'tab-1', url: 'https://example.com/' }]);

  it('routes Search + URL to Navigate', () => {
    const result = routeBrowserIntent(
      { text: 'https://example.com', capability: 'search' },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'navigate');
    }
  });

  it('routes Search + ordinary text to Search', () => {
    const result = routeBrowserIntent({ text: 'cats', capability: 'search' }, browser);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'search');
      assert.equal(result.route.query, 'cats');
    }
  });

  it('fails closed for Search + forbidden scheme', () => {
    const result = routeBrowserIntent(
      { text: 'javascript:alert(1)', capability: 'search' },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_SEARCH_INVALID');
    }
  });

  it('rejects valid URLs longer than MAX_BROWSER_INTENT_TEXT_CHARS', () => {
    const text = `https://example.com/${'a'.repeat(MAX_BROWSER_INTENT_TEXT_CHARS)}`;
    const result = routeBrowserIntent({ text, capability: 'search' }, browser);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });

  it('rejects context on search', () => {
    const result = routeBrowserIntent(
      {
        text: 'cats',
        capability: 'search',
        context: { kind: 'current-tab', tabId: 'tab-1' },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });
});

describe('routeBrowserIntent explicit Ask', () => {
  const browser = state([
    { id: 'tab-a', url: 'https://a.example/' },
    { id: 'tab-b', url: 'https://b.example/' },
    { id: 'tab-blank', url: 'about:blank' },
  ], 'tab-a');

  it('routes Ask on current live http tab', () => {
    const result = routeBrowserIntent(
      {
        text: 'Summarize this',
        capability: 'ask',
        context: { kind: 'current-tab', tabId: 'tab-a' },
      },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'ask');
      assert.equal(result.route.question, 'Summarize this');
    }
  });

  it('routes Ask on selected live http tabs', () => {
    const result = routeBrowserIntent(
      {
        text: 'Compare these',
        capability: 'ask',
        context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] },
      },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'ask');
      assert.deepEqual(result.route.context, { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] });
    }
  });

  it('rejects unknown tab in selected-tabs', () => {
    const result = routeBrowserIntent(
      {
        text: 'Compare',
        capability: 'ask',
        context: { kind: 'selected-tabs', tabIds: ['tab-a', 'missing'] },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_TAB_UNAVAILABLE');
    }
  });

  it('rejects current-tab that does not match the active tab', () => {
    const result = routeBrowserIntent(
      {
        text: 'Compare',
        capability: 'ask',
        context: { kind: 'current-tab', tabId: 'missing' },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });

  it('rejects about:blank for Ask', () => {
    const blankActive = state([{ id: 'tab-blank', url: 'about:blank' }], 'tab-blank');
    const result = routeBrowserIntent(
      {
        text: 'Summarize',
        capability: 'ask',
        context: { kind: 'current-tab', tabId: 'tab-blank' },
      },
      blankActive,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });

  it('rejects duplicate selected tab IDs', () => {
    const result = routeBrowserIntent(
      {
        text: 'Compare',
        capability: 'ask',
        context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-a'] },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });

  it('rejects more than five selected tabs', () => {
    const tabs = Array.from({ length: 6 }, (_, index) => ({
      id: `tab-${index}`,
      url: `https://example.com/${index}`,
    }));
    const largeBrowser = state(tabs);
    const result = routeBrowserIntent(
      {
        text: 'Compare',
        capability: 'ask',
        context: {
          kind: 'selected-tabs',
          tabIds: tabs.map((tab) => tab.id),
        },
      },
      largeBrowser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });

  it('requires context', () => {
    const result = routeBrowserIntent({ text: 'Summarize', capability: 'ask' }, browser);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });

  it('rejects current-tab that is not the active tab', () => {
    const result = routeBrowserIntent(
      {
        text: 'Summarize',
        capability: 'ask',
        context: { kind: 'current-tab', tabId: 'tab-b' },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });

  it('allows selected-tabs containing inactive valid http tabs', () => {
    const result = routeBrowserIntent(
      {
        text: 'Compare these',
        capability: 'ask',
        context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] },
      },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'ask');
    }
  });
});

describe('routeBrowserIntent explicit Act', () => {
  it('uses current trusted active tab without context', () => {
    const browser = state(
      [
        { id: 'tab-a', url: 'https://a.example/' },
        { id: 'tab-b', url: 'https://b.example/' },
      ],
      'tab-b',
    );
    const result = routeBrowserIntent(
      {
        text: 'Click safe control',
        capability: 'act',
      },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'act');
      assert.equal(result.route.tabId, 'tab-b');
    }
  });

  it('rejects context on act', () => {
    const browser = state(
      [
        { id: 'tab-a', url: 'https://a.example/' },
        { id: 'tab-b', url: 'https://b.example/' },
      ],
      'tab-b',
    );
    const result = routeBrowserIntent(
      {
        text: 'Click safe control',
        capability: 'act',
        context: { kind: 'current-tab', tabId: 'tab-a' },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });

  it('fails without active tab', () => {
    const browser: BrowserIntentRouterState = {
      tabs: [{ id: 'tab-a', url: 'https://a.example/', title: '', loading: false, canGoBack: false, canGoForward: false }],
      activeTabId: 'missing',
    };
    const result = routeBrowserIntent({ text: 'Click', capability: 'act' }, browser);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_TAB_UNAVAILABLE');
    }
  });

  it('fails when active tab is about:blank', () => {
    const browser = state([{ id: 'tab-a', url: 'about:blank' }], 'tab-a');
    const result = routeBrowserIntent({ text: 'Click', capability: 'act' }, browser);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_TAB_UNAVAILABLE');
    }
  });
});

describe('routeBrowserIntent explicit Delegate', () => {
  it('routes ordinary objective', () => {
    const browser = state([{ id: 'tab-a', url: 'https://a.example/' }], 'tab-a');
    const result = routeBrowserIntent(
      { text: 'Research hotels', capability: 'delegate' },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'delegate');
      assert.equal(result.route.objective, 'Research hotels');
    }
  });

  it('remains valid on about:blank', () => {
    const browser = state([{ id: 'tab-a', url: 'about:blank' }], 'tab-a');
    const result = routeBrowserIntent(
      { text: 'Research hotels', capability: 'delegate' },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'delegate');
    }
  });

  it('rejects context on delegate', () => {
    const browser = state([{ id: 'tab-a', url: 'https://a.example/' }], 'tab-a');
    const result = routeBrowserIntent(
      {
        text: 'Research hotels',
        capability: 'delegate',
        context: { kind: 'current-tab', tabId: 'tab-a' },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });
});

describe('routeBrowserIntent explicit Automate', () => {
  it('routes draft-workflow', () => {
    const browser = state([{ id: 'tab-a', url: 'about:blank' }], 'tab-a');
    const result = routeBrowserIntent(
      {
        text: 'Every weekday at 08:00 check this page',
        capability: 'automate',
        context: { kind: 'current-tab', tabId: 'tab-a' },
      },
      browser,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'draft-workflow');
    }
  });

  it('rejects oversized instruction text', () => {
    const browser = state([{ id: 'tab-a', url: 'https://a.example/' }], 'tab-a');
    const result = routeBrowserIntent(
      {
        text: 'x'.repeat(MAX_BROWSER_INTENT_TEXT_CHARS + 1),
        capability: 'automate',
        context: { kind: 'current-tab', tabId: 'tab-a' },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });

  it('rejects current-tab that is not the active tab', () => {
    const browser = state(
      [
        { id: 'tab-a', url: 'about:blank' },
        { id: 'tab-b', url: 'https://b.example/' },
      ],
      'tab-b',
    );
    const result = routeBrowserIntent(
      {
        text: 'Every weekday at 08:00 check this page',
        capability: 'automate',
        context: { kind: 'current-tab', tabId: 'tab-a' },
      },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });

  it('requires context', () => {
    const browser = state([{ id: 'tab-a', url: 'about:blank' }], 'tab-a');
    const result = routeBrowserIntent(
      { text: 'Every weekday at 08:00', capability: 'automate' },
      browser,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });
});

describe('browser-intent-router architecture boundary', () => {
  it('does not import main, browser, ai, agent-run, autonomous-task, or workflows modules', () => {
    const source = readFileSync(path.join(ROOT, 'src/ai-native/browser-intent-router.ts'), 'utf8');
    for (const forbidden of [
      '../main/',
      '../browser/',
      '../ai/',
      '../agent-run/',
      '../autonomous-task/',
      '../workflows/',
      'ModelRuntime',
      'ModelRouter',
      'ReadOnlyAgent',
      'observePage',
      'AutonomousTask',
      'WorkflowStore',
    ]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
