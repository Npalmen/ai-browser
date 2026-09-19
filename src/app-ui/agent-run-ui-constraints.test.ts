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
    assert.match(panel, /props\.isAsking && props\.mode !== 'delegate'/);
    assert.match(panel, /onClick=\{props\.onStop\}/);
    assert.match(panel, /Stop/);
    assert.equal(panel.includes('onApprove()'), false);
    assert.match(panel, /if \(event\.key === 'Enter'/);
    assert.match(panel, /props\.onAsk\(\)/);
    assert.match(panel, /props\.onDelegate\(\)/);
    assert.match(panel, /props\.onTaskReply\(\)/);
    assert.equal(panel.includes('onApprove'), true);
    const enterBlock = panel.slice(panel.indexOf('handleKeyDown'), panel.indexOf('return ('));
    assert.equal(enterBlock.includes('onApprove'), false);
    assert.equal(enterBlock.includes('decideApproval'), false);
    assert.match(panel, /disabled=\{\!props\.hasActiveTab \|\| inputLocked\}/);
  });

  it('adds Delegate without replacing Ask/Act or creating a second approval card', () => {
    const panel = readSrc('src/app-ui/AiSidePanel.tsx');
    assert.match(panel, /Delegate/);
    assert.match(panel, /Ask/);
    assert.match(panel, /Act/);
    assert.match(panel, /<ApprovalCard/);
    assert.match(panel, /<AutonomousTaskCard/);
    assert.equal((panel.match(/<ApprovalCard/g) ?? []).length, 1);
    assert.equal(panel.includes('Retry'), false);
    assert.equal(panel.includes('Approve task'), false);
    assert.equal(panel.includes('Approve all'), false);

    const app = readSrc('src/app-ui/App.tsx');
    assert.match(app, /startAutonomousTask\(\{ objective \}\)/);
    assert.match(app, /askCurrentPage\(\{ tabId, question/);
    assert.match(app, /replyToAutonomousTask/);
    assert.match(app, /pauseAutonomousTask/);
    assert.match(app, /resumeAutonomousTask/);
    assert.match(app, /stopAutonomousTask/);
    assert.match(app, /tab-task-owned/);
    assert.match(app, /ai-toggle-badge/);
    const closeBlock = app.slice(app.indexOf('handleClosePanel'), app.indexOf('updateActiveTabAi'));
    assert.equal(closeBlock.includes('cancelAsk'), false);
    assert.equal(closeBlock.includes('decideApproval'), false);
    assert.equal(closeBlock.includes('pauseAutonomousTask'), false);
    assert.equal(closeBlock.includes('stopAutonomousTask'), false);
    assert.match(closeBlock, /setPanelOpen\(false\)/);

    const card = readSrc('src/app-ui/AutonomousTaskCard.tsx');
    assert.equal(card.includes('Retry'), false);
    assert.match(card, /AUTONOMOUS_TASK_EXECUTION_UNKNOWN_COPY/);
    assert.match(card, /Pause/);
    assert.match(card, /Resume/);
    assert.match(card, /Stop/);
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
