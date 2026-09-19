import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { routeBrowserIntent } from '../ai-native/browser-intent-router';
import type { BrowserIntentRouterState } from '../shared/ai-native-types';

const ROOT = path.resolve(__dirname, '..', '..');

function browser(url = 'https://example.test/page'): BrowserIntentRouterState {
  return {
    activeTabId: 'tab-a',
    tabs: [
      {
        id: 'tab-a',
        url,
        title: 'Page',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
      {
        id: 'tab-b',
        url: 'https://example.test/b',
        title: 'B',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
  };
}

describe('V8 product routing', () => {
  it('routes a valid URL to Navigate and plain text to Search', () => {
    const url = routeBrowserIntent(
      { text: 'http://127.0.0.1:9/ai-readonly.html?q=1#frag', capability: 'default' },
      browser(),
    );
    assert.equal(url.ok, true);
    if (url.ok) {
      assert.equal(url.route.kind, 'navigate');
      assert.equal(url.route.url, 'http://127.0.0.1:9/ai-readonly.html?q=1#frag');
    }

    const search = routeBrowserIntent({ text: 'cats and dogs', capability: 'default' }, browser());
    assert.equal(search.ok, true);
    if (search.ok) {
      assert.equal(search.route.kind, 'search');
      assert.equal(search.route.query, 'cats and dogs');
    }
  });

  it('routes explicit Search of a URL to Navigate', () => {
    const result = routeBrowserIntent(
      { text: 'https://example.test/status', capability: 'search' },
      browser(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.route.kind, 'navigate');
    }
  });

  it('routes explicit Ask, Act, Delegate, and Automate without an LLM classifier', () => {
    const ask = routeBrowserIntent(
      {
        text: 'What is this?',
        capability: 'ask',
        context: { kind: 'current-tab', tabId: 'tab-a' },
      },
      browser(),
    );
    assert.equal(ask.ok, true);
    if (ask.ok) {
      assert.equal(ask.route.kind, 'ask');
    }

    const selected = routeBrowserIntent(
      {
        text: 'Compare',
        capability: 'ask',
        context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] },
      },
      browser(),
    );
    assert.equal(selected.ok, true);
    if (selected.ok) {
      assert.equal(selected.route.kind, 'ask');
      assert.equal(selected.route.context.kind, 'selected-tabs');
    }

    const act = routeBrowserIntent({ text: 'Click expand', capability: 'act' }, browser());
    assert.equal(act.ok, true);
    if (act.ok) {
      assert.equal(act.route.kind, 'act');
      assert.equal(act.route.tabId, 'tab-a');
    }

    const delegate = routeBrowserIntent(
      { text: 'Watch this page', capability: 'delegate' },
      browser(),
    );
    assert.equal(delegate.ok, true);
    if (delegate.ok) {
      assert.equal(delegate.route.kind, 'delegate');
    }

    const automate = routeBrowserIntent(
      {
        text: 'Every weekday check https://example.test/status',
        capability: 'automate',
        context: { kind: 'current-tab', tabId: 'tab-a' },
      },
      browser(),
    );
    assert.equal(automate.ok, true);
    if (automate.ok) {
      assert.equal(automate.route.kind, 'draft-workflow');
    }
  });

  it('never returns Act, Delegate, or Automate for default input', () => {
    for (const text of ['cats', 'https://example.test', 'approve', 'run it now']) {
      const result = routeBrowserIntent({ text, capability: 'default' }, browser());
      assert.equal(result.ok, true, text);
      if (result.ok) {
        assert.equal(['navigate', 'search'].includes(result.route.kind), true, text);
      }
    }
  });

  it('does not import a model runtime for routing', () => {
    const router = readFileSync(path.join(ROOT, 'src/ai-native/browser-intent-router.ts'), 'utf8');
    assert.equal(router.includes('ModelRuntime'), false);
    assert.equal(router.includes('AiSdkGatewayRuntime'), false);
    assert.equal(router.includes('generate('), false);
  });
});
