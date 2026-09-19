import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('V8 omnibox integration', () => {
  it('routes default/search through aiNative.routeIntent and trusted browser shell execution', () => {
    const app = readSrc('src/app-ui/App.tsx');
    assert.match(app, /window\.aiNative[\s\S]*routeIntent/);
    assert.match(app, /route\.kind === 'navigate'/);
    assert.match(app, /window\.browserShell\.navigate\(tabId, route\.url\)/);
    assert.match(app, /route\.kind === 'search'/);
    assert.match(app, /window\.browserShell\.search\(tabId, route\.query\)/);
    assert.equal(app.includes('browserShell.navigate(activeTab.id, addressDraft)'), false);
    assert.equal(app.includes('browserShell.navigate(activeTab.id, omniboxState.draft)'), false);
  });

  it('does not execute Ask/Act/Delegate/Automate from omnibox submit', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const submitBlock = app.slice(app.indexOf('handleOmniboxSubmit'), app.indexOf('openRightPanel'));
    assert.equal(submitBlock.includes('askContext('), false);
    assert.equal(submitBlock.includes('askCurrentPage('), false);
    assert.equal(submitBlock.includes('startAutonomousTask('), false);
    assert.match(submitBlock, /isExecutableCapability/);
    assert.match(submitBlock, /setPhaseUnavailable/);

    const omnibox = readSrc('src/app-ui/Omnibox.tsx');
    assert.equal(omnibox.includes('askContext('), false);
    assert.equal(omnibox.includes('askCurrentPage('), false);
    assert.equal(omnibox.includes('startAutonomousTask('), false);
    assert.equal(omnibox.includes('workflows.create('), false);
    assert.equal(omnibox.includes('decideApproval('), false);
  });

  it('implements Ctrl/Cmd+L focus and new-tab omnibox focus', () => {
    const app = readSrc('src/app-ui/App.tsx');
    assert.match(app, /event\.key\.toLowerCase\(\) === 'l'/);
    assert.match(app, /event\.ctrlKey \|\| event\.metaKey/);
    assert.match(app, /pendingOmniboxFocusRef/);
    assert.match(app, /omniboxInputRef\.current\?\.focus\(\)/);
    assert.match(app, /about:blank/);
  });

  it('closes context picker when approval is required', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const approvalStart = app.indexOf("event.type === 'approval-required'");
    assert.ok(approvalStart >= 0);
    const approvalBlock = app.slice(approvalStart, approvalStart + 500);
    assert.match(approvalBlock, /closeContextPicker/);
  });

  it('keeps omnibox in trusted app renderer only', () => {
    const adapter = readSrc('src/browser/electron-adapter.ts');
    const blockStart = adapter.indexOf('private createWebsiteView()');
    const block = adapter.slice(blockStart, blockStart + 450);
    assert.equal(block.includes('preload:'), false);
  });
});
