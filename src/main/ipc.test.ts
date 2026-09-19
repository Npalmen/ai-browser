import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('autonomous task IPC wiring', () => {
  it('awaits V6 lifecycle before trusted chrome navigation and tab close', () => {
    const ipc = readSrc('src/main/ipc.ts');
    for (const channel of [
      'BROWSER_IPC_CHANNELS.navigate',
      'BROWSER_IPC_CHANNELS.back',
      'BROWSER_IPC_CHANNELS.forward',
      'BROWSER_IPC_CHANNELS.reload',
    ]) {
      const start = ipc.indexOf(channel);
      assert.ok(start >= 0, channel);
      const block = ipc.slice(start, start + 750);
      const taskIndex = block.indexOf('await beforeAutonomousTaskTrustedChromeNavigation(trustedTabId)');
      const cancelIndex = block.indexOf('cancelAgentRunForTrustedChromeNavigation(trustedTabId)');
      const navigateIndex = Math.max(
        block.indexOf('getBrowserAdapter().navigate'),
        block.indexOf('getBrowserAdapter().back'),
        block.indexOf('getBrowserAdapter().forward'),
        block.indexOf('getBrowserAdapter().reload'),
      );
      assert.ok(taskIndex >= 0, `${channel} awaits V6`);
      assert.ok(cancelIndex > taskIndex, `${channel} V5 cancel after V6`);
      assert.ok(navigateIndex > cancelIndex, `${channel} adapter after drain`);
    }

    const closeStart = ipc.indexOf('BROWSER_IPC_CHANNELS.closeTab');
    const closeBlock = ipc.slice(closeStart, closeStart + 700);
    const taskClose = closeBlock.indexOf('await handleAutonomousTaskTabClosed(trustedTabId)');
    const aiClose = closeBlock.indexOf('getAiController()?.handleTabClosed(trustedTabId)');
    const adapterClose = closeBlock.indexOf('getBrowserAdapter().closeTab(trustedTabId)');
    assert.ok(taskClose >= 0);
    assert.ok(aiClose > taskClose);
    assert.ok(adapterClose > aiClose);
  });

  it('requires trusted sender before every autonomous-task handler and has no execution channels', () => {
    const ipc = readSrc('src/main/ipc.ts');
    for (const channel of [
      'AUTONOMOUS_TASK_IPC_CHANNELS.start',
      'AUTONOMOUS_TASK_IPC_CHANNELS.pause',
      'AUTONOMOUS_TASK_IPC_CHANNELS.resume',
      'AUTONOMOUS_TASK_IPC_CHANNELS.stop',
      'AUTONOMOUS_TASK_IPC_CHANNELS.reply',
      'AUTONOMOUS_TASK_IPC_CHANNELS.getState',
    ]) {
      const start = ipc.indexOf(channel);
      assert.ok(start >= 0, channel);
      const block = ipc.slice(start, start + 900);
      const sender = block.indexOf('assertTrustedAppSender(event)');
      assert.ok(sender >= 0, `${channel} sender`);
      const controller = block.indexOf('getAutonomousTaskController');
      const runtime = block.indexOf('getPersistentWorkflowRuntime');
      const gate = [controller, runtime].filter((index) => index >= 0).sort((left, right) => left - right)[0];
      assert.ok(
        channel.includes('getState') || (gate !== undefined && sender < gate),
        channel,
      );
    }
    for (const forbidden of [
      'autonomous-task:execute-child',
      'autonomous-task:execute-action',
      'autonomous-task:approve',
      'autonomous-task:set-target',
      'autonomous-task:set-tab-owner',
      'adoptTaskTab',
      'releaseTaskTab',
    ]) {
      assert.equal(ipc.includes(forbidden), false, forbidden);
    }
  });

  it('routes tab-created and generic navigation without double-running V6 tab-close', () => {
    const main = readSrc('src/main/main.ts');
    assert.match(main, /onTabCreated:/);
    assert.match(main, /handleAutonomousTaskTabCreated\(event\)/);
    const callback = main.slice(
      main.indexOf('onTabInvalidated:'),
      main.indexOf('initializeAiRuntime(adapter)'),
    );
    assert.match(callback, /reason === 'navigation'/);
    assert.match(callback, /handleAutonomousTaskGenericNavigation\(tabId\)/);
    assert.match(callback, /handleAutonomousTaskRendererCrash\(tabId\)/);
    assert.equal(callback.includes('handleAutonomousTaskTabClosed'), false);
    assert.match(callback, /getAiController\(\)\?\.handleTabClosed/);
  });

  it('no-ops V6 browser callbacks before AI runtime init', () => {
    const runtime = readSrc('src/main/ai-runtime.ts');
    assert.match(runtime, /void autonomousTaskController\?\.handleTabCreated/);
    assert.match(runtime, /\?\.catch\(\(\) => \{/);
    assert.match(runtime, /autonomousTaskController\?\.handleGenericNavigation/);
    assert.match(runtime, /await autonomousTaskController\?\.beforeTrustedChromeNavigation/);
    assert.match(runtime, /await autonomousTaskController\?\.handleTabClosed/);
    assert.match(runtime, /void autonomousTaskController\?\.handleRendererCrash/);
  });
});
