import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function readSrc(relative: string): string {
  return readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
}

describe('V5 AgentRun UI constraints', () => {
  it('keeps Stop available via activeAskId and does not map Enter to Approve', () => {
    const panel = readSrc('src/app-ui/AiSidePanel.tsx');
    assert.match(panel, /props\.isAsking \?/);
    assert.match(panel, /onClick=\{props\.onStop\}/);
    assert.match(panel, /Stop/);
    assert.equal(panel.includes('onApprove()'), false);
    assert.match(panel, /if \(event\.key === 'Enter'/);
    assert.match(panel, /props\.onAsk\(\)/);
    assert.equal(panel.includes('onApprove'), true);
    const enterBlock = panel.slice(panel.indexOf('handleKeyDown'), panel.indexOf('return ('));
    assert.equal(enterBlock.includes('onApprove'), false);
    assert.match(panel, /disabled=\{\!props\.hasActiveTab \|\| inputLocked\}/);
  });

  it('reuses the V4 approval card and has no Retry for unknown', () => {
    const panel = readSrc('src/app-ui/AiSidePanel.tsx');
    assert.match(panel, /<ApprovalCard/);
    assert.match(panel, /onApprove=\{\(\) => props\.onApprove\?\.\(\)\}/);
    assert.match(panel, /onReject=\{\(\) => props\.onReject\?\.\(\)\}/);
    assert.equal(panel.includes('Retry'), false);

    const card = readSrc('src/app-ui/ApprovalCard.tsx');
    assert.equal(card.includes('Retry'), false);
    assert.match(card, /status === 'unknown'/);

    const app = readSrc('src/app-ui/App.tsx');
    const closeBlock = app.slice(app.indexOf('handleClosePanel'), app.indexOf('updateActiveTabAi'));
    assert.equal(closeBlock.includes('cancelAsk'), false);
    assert.equal(closeBlock.includes('decideApproval'), false);
    assert.match(closeBlock, /setPanelOpen\(false\)/);
  });

  it('does not add run execution IPC', () => {
    const ipc = readSrc('src/main/ipc.ts');
    for (const token of ['cancelRun', 'executeRun', 'resumeRun', 'agent:execute', 'agent:approve', 'run:execute']) {
      assert.equal(ipc.includes(token), false, token);
    }
    assert.match(ipc, /AI_IPC_CHANNELS.cancelAsk/);
    assert.match(ipc, /APPROVAL_IPC_CHANNELS.decide/);
  });
});
