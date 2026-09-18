import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isMainFrameNavigationInvalidation } from './tab-invalidation';

const ROOT = path.resolve(__dirname, '..', '..');

describe('tab invalidation', () => {
  it('invalidates only main-frame navigations', () => {
    assert.equal(isMainFrameNavigationInvalidation({ isMainFrame: true }), true);
    assert.equal(isMainFrameNavigationInvalidation({ isMainFrame: false }), false);
    assert.equal(isMainFrameNavigationInvalidation({}), false);
  });

  it('wires website lifecycle to a callback without importing approval authority', () => {
    const source = readFileSync(path.join(ROOT, 'src/browser/electron-adapter.ts'), 'utf8');
    assert.match(source, /onTabInvalidated\?/);
    assert.match(source, /did-start-navigation/);
    assert.match(source, /isMainFrameNavigationInvalidation/);
    assert.match(source, /onTabInvalidated\?\.\(tabId, 'navigation'\)/);
    assert.match(source, /onTabInvalidated\?\.\(tabId, 'tab-close'\)/);
    assert.match(source, /onTabInvalidated\?\.\(tabId, 'renderer-crash'\)/);
    assert.equal(source.includes('ApprovalManager'), false);
    assert.equal(source.includes('claimExecuteGrant'), false);
    assert.equal(source.includes('ExecuteGrant'), false);
  });
});
