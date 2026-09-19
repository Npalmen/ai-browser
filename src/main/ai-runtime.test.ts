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
    assert.match(source, /new AgentRunExecutor\(/);
    assert.match(source, /new AgentRunController\(/);
    assert.match(source, /executor: agentRunExecutor/);
    assert.equal(source.split('new AutonomousTaskChildRunExecutor(').length - 1, 1);
    assert.equal(source.split('new AutonomousTaskCoordinator(').length - 1, 1);
    assert.equal(source.split('new AutonomousTaskPlanner(').length - 1, 1);
    assert.equal(source.split('new AutonomousTaskPlannerExecutor(').length - 1, 1);
    assert.equal(source.split('new AutonomousTaskApprovalIntegration(').length - 1, 1);
    assert.equal(source.split('new AutonomousTaskLifecycleController(').length - 1, 1);
    assert.equal(source.split('new AutonomousTaskController(').length - 1, 1);
    assert.equal(source.split('new AutonomousTaskApprovalPortProxy(').length - 1, 1);
    assert.equal(source.split('new CompositeAgentRunApprovalOutcomePort(').length - 1, 1);
    assert.equal(source.split('new AiSdkGatewayRuntime(').length - 1, 1);
    assert.equal(source.split('new AgentRunExecutor(').length - 1, 1);
    assert.match(source, /new ApprovalManager\(/);
    assert.match(source, /new ApprovalLifecycle\(/);
    assert.match(source, /new ApprovalWorkflowController\(/);
    assert.equal(source.includes('new InteractiveAgent('), false);
    assert.equal(source.includes('new InteractionCoordinator('), false);
    assert.equal(source.includes('interactiveAgent'), false);
    assert.equal(source.split('new ApprovalManager(').length - 1, 1);
    assert.equal(source.split('new AgentRunCoordinator(').length - 1, 1);
    assert.match(source, /task: taskApprovalProxy/);
    assert.match(source, /agentRun: agentRunCoordinator/);
    assert.match(source, /agentRun: approvalOutcome/);
    assert.match(source, /approvalOutcome\.notifyApprovalOutcome/);
    assert.match(source, /taskApproval: taskApprovalProxy/);
    assert.match(source, /canStartManualAct:/);
    assert.match(source, /taskApprovalProxy\.bind\(taskApprovalIntegration\)/);
    assert.match(source, /runtime: gatewayRuntime/);
    assert.match(source, /autonomousTaskController\?\.dispose\(\)/);
    assert.match(source, /autonomousTaskApprovalIntegration\?\.dispose\(\)/);
    assert.match(source, /autonomousTaskCoordinator\?\.dispose\(\)/);
    assert.match(source, /interactionExecutor,/);
    assert.match(source, /approvalPort: approvalBridge/);
    assert.match(source, /agentRuns: agentRunController/);
    assert.match(source, /agentRunExecutor\?\.dispose\(\)/);
    assert.match(source, /new ReadOnlyAgent\(/);
    assert.match(source, /new AiNativeActivityController\(/);
    assert.match(source, /getActivitySnapshot\(\)/);
    assert.match(source, /hasActiveAsk\(\)/);
    assert.match(source, /getSlotOwner\(\)/);
    assert.match(source, /getPendingForTab\(tabId\)/);
    assert.match(source, /activityController = null/);
    assert.match(source, /options\?\.modelRuntime \?\? new AiSdkGatewayRuntime/);
    assert.match(source, /export type AiRuntimeModelInjection/);
  });

  it('does not expose a renderer, IPC, or environment model-runtime selector', () => {
    const runtime = readSrc('src/main/ai-runtime.ts');
    const ipc = readSrc('src/main/ipc.ts');
    const preload = readSrc('src/preload/app-preload.ts');
    const main = readSrc('src/main/main.ts');
    assert.match(main, /initializeAiRuntime\(adapter\)/);
    assert.equal(main.includes('modelRuntime'), false);
    assert.equal(ipc.includes('modelRuntime'), false);
    assert.equal(preload.includes('modelRuntime'), false);
    assert.equal(runtime.includes('AI_GATEWAY_API_KEY'), false);
    assert.equal(runtime.includes('process.env'), false);
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
      const block = ipc.slice(start, start + 750);
      const taskIndex = block.indexOf('await beforeAutonomousTaskTrustedChromeNavigation(trustedTabId)');
      const cancelIndex = block.indexOf('cancelAgentRunForTrustedChromeNavigation(trustedTabId)');
      const invalidateIndex = block.indexOf('invalidateApprovalTab(trustedTabId)');
      assert.ok(taskIndex >= 0, `${channel} V6`);
      assert.ok(cancelIndex > taskIndex, `${channel} cancel`);
      assert.ok(invalidateIndex > cancelIndex, `${channel} invalidate after cancel`);
    }

    const closeStart = ipc.indexOf('BROWSER_IPC_CHANNELS.closeTab');
    const closeBlock = ipc.slice(closeStart, closeStart + 700);
    assert.equal(closeBlock.includes('cancelAgentRunForTrustedChromeNavigation'), false);
    assert.match(closeBlock, /handleAutonomousTaskTabClosed/);
    assert.match(closeBlock, /handleTabClosed/);

    const main = readSrc('src/main/main.ts');
    assert.match(main, /reason === 'renderer-crash'/);
    assert.match(main, /reason === 'tab-close'/);
    assert.match(main, /reason === 'navigation'/);
    const callback = main.slice(
      main.indexOf('onTabInvalidated:'),
      main.indexOf('initializeAiRuntime(adapter)'),
    );
    assert.equal(callback.includes('cancelForTrustedChromeNavigation'), false);
    assert.match(callback, /handleRendererCrash/);
    assert.match(callback, /handleAutonomousTaskGenericNavigation/);
    assert.match(callback, /invalidateApprovalTab\(tabId\)/);
    assert.match(main, /onTabCreated:/);
  });
});
