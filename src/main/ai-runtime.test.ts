import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('ai-runtime composition', () => {
  it('wires one shared AgentRunCoordinator into Act, V4, and lifecycle', () => {
    const source = readSrc('src/main/ai-runtime.ts');
    assert.equal(source.includes('new TargetRegistry'), false);
    assert.match(source, /getInteractionTargetRegistry\(\)/);
    assert.match(source, /new InteractionExecutor\(/);
    assert.match(source, /new ReadOnlyAgent\(/);
    assert.match(source, /new InteractiveStepAgent\(/);
    assert.match(source, /new AgentRunCoordinator\(/);
    assert.match(source, /new AgentRunApprovalBridge\(/);
    assert.match(source, /new SafeAgentLoop\(/);
    assert.match(source, /new AgentRunController\(/);
    assert.match(source, /new ApprovalManager\(/);
    assert.match(source, /new ApprovalLifecycle\(/);
    assert.match(source, /new ApprovalWorkflowController\(/);
    assert.equal(source.includes('new InteractiveAgent('), false);
    assert.equal(source.includes('new InteractionCoordinator('), false);
    assert.equal(source.includes('interactiveAgent'), false);
    assert.equal(source.split('new ApprovalManager(').length - 1, 1);
    assert.equal(source.split('new AgentRunCoordinator(').length - 1, 1);
    assert.match(source, /agentRun: agentRunCoordinator/);
    assert.match(source, /notifyAgentRunOutcome:/);
    assert.match(source, /agentRunCoordinator\.notifyApprovalOutcome/);
    assert.match(source, /interactionExecutor,/);
    assert.match(source, /approvalPort: approvalBridge/);
    assert.match(source, /agentRuns: agentRunController/);
  });

  it('does not call InteractiveAgent.interact on the production Act path', () => {
    const runtime = readSrc('src/main/ai-runtime.ts');
    const controller = readSrc('src/main/ai-request-controller.ts');
    assert.equal(runtime.includes('.interact('), false);
    assert.match(controller, /runAgentRunAsk/);
    assert.match(controller, /this\.agentRuns\.start/);
    assert.equal(controller.includes('this.interactiveAgent.interact'), true);
    const productionBranch = controller.slice(
      controller.indexOf('private async runAgentRunAsk'),
      controller.indexOf('private async runInteractAsk'),
    );
    assert.equal(productionBranch.includes('.interact('), false);
  });

  it('exposes a no-op invalidation helper when runtime is uninitialized', () => {
    const source = readSrc('src/main/ai-runtime.ts');
    assert.match(source, /export function invalidateApprovalTab/);
    assert.match(source, /approvalRuntime\?\.lifecycle\.invalidateTab\(tabId\)/);
  });
});

describe('trusted chrome vs generic navigation', () => {
  it('cancels AgentRun only for trusted chrome navigation and renderer-crash/tab-close', () => {
    const ipc = readSrc('src/main/ipc.ts');
    for (const channel of [
      'BROWSER_IPC_CHANNELS.navigate',
      'BROWSER_IPC_CHANNELS.back',
      'BROWSER_IPC_CHANNELS.forward',
      'BROWSER_IPC_CHANNELS.reload',
    ]) {
      const start = ipc.indexOf(channel);
      assert.ok(start >= 0, channel);
      const block = ipc.slice(start, start + 550);
      const cancelIndex = block.indexOf('cancelAgentRunForTrustedChromeNavigation(trustedTabId)');
      const invalidateIndex = block.indexOf('invalidateApprovalTab(trustedTabId)');
      assert.ok(cancelIndex >= 0, `${channel} cancel`);
      assert.ok(invalidateIndex > cancelIndex, `${channel} invalidate after cancel`);
    }

    const closeStart = ipc.indexOf('BROWSER_IPC_CHANNELS.closeTab');
    const closeBlock = ipc.slice(closeStart, closeStart + 450);
    assert.equal(closeBlock.includes('cancelAgentRunForTrustedChromeNavigation'), false);
    assert.match(closeBlock, /handleTabClosed/);

    const main = readSrc('src/main/main.ts');
    assert.match(main, /reason === 'renderer-crash'/);
    assert.match(main, /reason === 'tab-close'/);
    assert.equal(main.includes("reason === 'navigation'"), false);
    const callback = main.slice(
      main.indexOf('onTabInvalidated:'),
      main.indexOf('initializeAiRuntime(adapter)'),
    );
    assert.equal(callback.includes('cancelForTrustedChromeNavigation'), false);
    assert.match(callback, /handleRendererCrash/);
    assert.match(callback, /invalidateApprovalTab\(tabId\)/);
  });
});
