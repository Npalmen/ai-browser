import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function submitBlock(app: string): string {
  const start = app.indexOf('handleOmniboxSubmit');
  const end = app.indexOf('const openRightPanel', start);
  return app.slice(start, end >= 0 ? end : start + 6000);
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

  it('wires Ask current-tab through shared startCurrentPageRequest with mode read', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const submit = submitBlock(app);
    assert.match(submit, /route\.kind === 'ask'/);
    assert.match(submit, /route\.context\.kind === 'current-tab'/);
    assert.match(submit, /startCurrentPageRequest\(\{[\s\S]*mode: 'read'/);
    assert.match(app, /askCurrentPage\(\{ tabId, question: text, mode \}\)/);
    assert.match(app, /void startCurrentPageRequest/);
  });

  it('wires Ask selected-tabs through askContext, not askCurrentPage', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const submit = submitBlock(app);
    assert.match(submit, /startContextAsk\(route\.question, route\.context\.tabIds\)/);
    assert.match(app, /window\.aiNative\.askContext/);
    assert.match(app, /kind: 'selected-tabs'/);
    const askBlock = app.slice(app.indexOf('const startContextAsk'), app.indexOf('const startDelegateTask'));
    assert.equal(askBlock.includes('askCurrentPage'), false);
  });

  it('wires Act through shared startCurrentPageRequest with mode interact', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const submit = submitBlock(app);
    assert.match(submit, /route\.kind === 'act'/);
    assert.match(submit, /mode: 'interact'/);
    assert.match(submit, /route\.instruction/);
  });

  it('wires Delegate through shared startDelegateTask', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const submit = submitBlock(app);
    assert.match(submit, /route\.kind === 'delegate'/);
    assert.match(submit, /startDelegateTask\(route\.objective\)/);
    assert.match(app, /startAutonomousTask\(\{ objective \}\)/);
    assert.match(app, /void startDelegateTask/);
  });

  it('wires Automate draft-workflow through generateWorkflowDraft without workflow execution', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const submit = submitBlock(app);
    assert.match(submit, /route\.kind === 'draft-workflow'/);
    assert.match(submit, /startWorkflowDraft/);
    assert.match(app, /generateWorkflowDraft/);
    assert.equal(submit.includes('setPhaseUnavailable'), false);
    assert.equal(submit.includes('workflows.create'), false);
    assert.equal(submit.includes('runNow'), false);
    assert.equal(submit.includes('askContext'), false);
    assert.equal(submit.includes('startAutonomousTask'), false);
    const askBlock = app.slice(app.indexOf('if (route.kind === \'ask\')'), app.indexOf('if (route.kind === \'act\')'));
    const actBlock = app.slice(app.indexOf('if (route.kind === \'act\')'), app.indexOf('if (route.kind === \'delegate\')'));
    const delegateBlock = app.slice(app.indexOf('if (route.kind === \'delegate\')'), app.indexOf('if (route.kind === \'draft-workflow\')'));
    assert.equal(askBlock.includes('generateWorkflowDraft'), false);
    assert.equal(actBlock.includes('generateWorkflowDraft'), false);
    assert.equal(delegateBlock.includes('generateWorkflowDraft'), false);
  });

  it('resets omnibox after successful AI capability start', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const submit = submitBlock(app);
    assert.match(submit, /resetAfterSuccessfulAiSubmit/);
  });

  it('subscribes to context answer events and cancels through aiNative', () => {
    const app = readSrc('src/app-ui/App.tsx');
    assert.match(app, /window\.aiNative\.onContextAnswerEvent/);
    assert.match(app, /applyContextAnswerEvent/);
    assert.match(app, /window\.aiNative[\s\S]*cancelContextAsk/);
    assert.match(app, /handleContextStop/);
    assert.equal(app.includes('cancelAsk'), true);
    const contextStop = app.slice(app.indexOf('handleContextStop'), app.indexOf('handleApprovalDecision'));
    assert.equal(contextStop.includes('cancelAsk'), false);
  });

  it('clears context answer UI state with Assistant Clear', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const clearBlock = app.slice(app.indexOf('handleClear'), app.indexOf('handleDelegate'));
    assert.match(clearBlock, /clearContextAnswerState/);
    assert.match(clearBlock, /clearConversation/);
  });

  it('renders selected-tabs answers in AiSidePanel', () => {
    const panel = readSrc('src/app-ui/AiSidePanel.tsx');
    assert.match(panel, /contextAnswerEntries/);
    assert.match(panel, /Selected tabs/);
    assert.match(panel, /onContextStop/);
    assert.equal(panel.includes('decideApproval'), false);
  });

  it('omnibox components contain no approval controls', () => {
    const omnibox = readSrc('src/app-ui/Omnibox.tsx');
    const picker = readSrc('src/app-ui/OmniboxContextPicker.tsx');
    assert.equal(omnibox.includes('decideApproval'), false);
    assert.equal(omnibox.includes('onApprove'), false);
    assert.equal(picker.includes('decideApproval'), false);
    assert.equal(picker.includes('onApprove'), false);
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
