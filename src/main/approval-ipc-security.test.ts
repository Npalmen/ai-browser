import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isExactTrustedAppSender } from './ipc-security';
import { APPROVAL_IPC_CHANNELS } from '../shared/ipc-contract';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('approval IPC security', () => {
  it('requires exact trusted sender and mainFrame identity', () => {
    const mainWebContents = { id: 'main-wc' };
    const mainFrame = { id: 'main-frame' };
    const websiteWebContents = { id: 'website-wc' };
    const websiteFrame = { id: 'website-frame' };
    const similarMain = { id: 'main-wc' };

    assert.equal(isExactTrustedAppSender(mainWebContents, mainFrame, mainWebContents, mainFrame), true);
    assert.equal(isExactTrustedAppSender(websiteWebContents, mainFrame, mainWebContents, mainFrame), false);
    assert.equal(isExactTrustedAppSender(mainWebContents, websiteFrame, mainWebContents, mainFrame), false);
    assert.equal(isExactTrustedAppSender(mainWebContents, null, mainWebContents, mainFrame), false);
    assert.equal(isExactTrustedAppSender(similarMain, mainFrame, mainWebContents, mainFrame), false);
  });

  it('exposes only decide and event approval channels', () => {
    assert.deepEqual(Object.keys(APPROVAL_IPC_CHANNELS), ['decide', 'event']);
    assert.deepEqual(Object.values(APPROVAL_IPC_CHANNELS), ['approval:decide', 'approval:event']);
    for (const value of Object.values(APPROVAL_IPC_CHANNELS)) {
      for (const forbidden of ['click', 'execute', 'grant', 'proposal', 'target', 'prepare']) {
        assert.equal(value.includes(forbidden), false, `${value} contains ${forbidden}`);
      }
    }
  });

  it('checks trusted sender before parsing approval decide input', () => {
    const ipc = readSrc('src/main/ipc.ts');
    const start = ipc.indexOf('APPROVAL_IPC_CHANNELS.decide');
    assert.ok(start >= 0);
    const block = ipc.slice(start, start + 900);
    const senderIndex = block.indexOf('assertTrustedAppSender(event)');
    const parseIndex = block.indexOf('parseApprovalDecideRequest');
    assert.ok(senderIndex >= 0);
    assert.ok(parseIndex > senderIndex);
    for (const forbidden of [
      'approval:execute',
      'approval:click',
      'approval:grant',
      'approval:create',
      'approval:prepare',
      'approval:target',
    ]) {
      assert.equal(ipc.includes(forbidden), false, forbidden);
    }
  });

  it('keeps Phase 3 decision composition free of execution', () => {
    const files = [
      'src/main/approval-controller.ts',
      'src/preload/app-preload.ts',
      'src/main/approval-ipc-guards.ts',
      'src/main/approval-safe-error.ts',
    ];
    const forbidden = [
      'claimExecuteGrant(',
      'markAdapterPrimitiveInvoked(',
      'BrowserAdapter',
      'ElectronBrowserAdapter',
      'TargetRegistry',
      'InteractionExecutor',
      'ExecuteExecutor',
      'dispatchMouse',
      'Input.dispatch',
      'executeJavaScript',
      'Runtime.',
    ];
    for (const file of files) {
      const source = readSrc(file);
      for (const token of forbidden) {
        assert.equal(source.includes(token), false, `${file} leaked ${token}`);
      }
    }

    const ipc = readSrc('src/main/ipc.ts');
    const start = ipc.indexOf('APPROVAL_IPC_CHANNELS.decide');
    const block = ipc.slice(start, start + 900);
    for (const token of [
      'claimExecuteGrant(',
      'markAdapterPrimitiveInvoked(',
      'ExecuteExecutor',
      'InteractionExecutor',
      'TargetRegistry',
      'dispatchMouse',
      'executeJavaScript',
    ]) {
      assert.equal(block.includes(token), false, `approval handler leaked ${token}`);
    }
    assert.match(block, /getApprovalWorkflowController/);
    assert.equal(block.includes('getApprovalController'), false);
  });

  it('invalidates approvals before trusted chrome navigation and tab close', () => {
    const ipc = readSrc('src/main/ipc.ts');
    for (const channel of [
      'BROWSER_IPC_CHANNELS.navigate',
      'BROWSER_IPC_CHANNELS.back',
      'BROWSER_IPC_CHANNELS.forward',
      'BROWSER_IPC_CHANNELS.reload',
      'BROWSER_IPC_CHANNELS.closeTab',
    ]) {
      const start = ipc.indexOf(channel);
      assert.ok(start >= 0, channel);
      const block = ipc.slice(start, start + 450);
      const senderIndex = block.indexOf('assertTrustedAppSender(event)');
      const invalidateIndex = block.indexOf('invalidateApprovalTab(trustedTabId)');
      assert.ok(senderIndex >= 0, `${channel} sender`);
      assert.ok(invalidateIndex > senderIndex, `${channel} invalidate order`);
    }
  });
});
