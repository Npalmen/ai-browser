import assert from 'node:assert/strict';

import { app, BrowserWindow } from 'electron';

import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import type { BrowserTabCreatedEvent } from '../browser/tab-creation';
import { startObservationFixtureServer } from '../../scripts/observation-fixture-server';
import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';
import {
  createV6ProductChain,
  lastPendingApproval,
  waitUntil,
} from './chain-helpers';
import {
  V6_BACKGROUND_PATH,
  V6_CONSEQUENTIAL_PATH,
  V6_POPUP_CLICK_PATH,
  V6_TWO_SAFE_PATH,
} from './fixture-constants';
import { findNodeByName } from './context-helpers';
import { RecordingPlannerRuntime } from './recording-planner-runtime';
import { V6AcceptanceModelRuntime } from './recording-agent-model-runtime';

delete process.env.AI_GATEWAY_API_KEY;

async function waitForObservation(
  adapter: ElectronBrowserAdapter,
  tabId: TabId,
): Promise<PageObservation> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const observation = await adapter.observePage(tabId, { includeScreenshot: false });
    if (!observation.document.loading) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for page observation');
}

async function run(): Promise<void> {
  assert.equal(process.env.AI_GATEWAY_API_KEY, undefined);
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.disableHardwareAcceleration();
  await app.whenReady();

  const fixture = await startObservationFixtureServer();
  const window = new BrowserWindow({
    show: true,
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  window.setAlwaysOnTop(true);
  window.show();
  window.focus();

  const tabCreated = {
    handler: (_event: BrowserTabCreatedEvent) => {
      // Assigned after the product chain is created.
    },
  };
  const invalidation = {
    handler: (_tabId: TabId, _reason: string) => {
      // Assigned after the product chain is created.
    },
  };
  const adapter = new ElectronBrowserAdapter(window, {
    onTabCreated: (event) => {
      tabCreated.handler(event);
    },
    onTabInvalidated: (tabId, reason) => {
      invalidation.handler(tabId, reason);
    },
  });
  const originalObservePage = adapter.observePage.bind(adapter);
  Reflect.set(
    adapter,
    'observePage',
    async (tabId: TabId, options?: Parameters<ElectronBrowserAdapter['observePage']>[1]) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const observation = await originalObservePage(tabId, options);
        if (!observation.document.loading) {
          return observation;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for stable observation');
    },
  );

  const tabs = { a: '' as TabId };
  const primitiveCounts = { click: 0, clickOnA: 0 };
  const originalClick = adapter.click.bind(adapter);
  Reflect.set(adapter, 'click', async (request: Parameters<ElectronBrowserAdapter['click']>[0]) => {
    primitiveCounts.click += 1;
    if (request.target.tabId === tabs.a) {
      primitiveCounts.clickOnA += 1;
    }
    return originalClick(request);
  });

  let currentObjective = '';
  const plannerSteps = new Map<string, number>();
  const plannerRuntime = new RecordingPlannerRuntime(() => {
    const step = (plannerSteps.get(currentObjective) ?? 0) + 1;
    plannerSteps.set(currentObjective, step);
    if (currentObjective.includes('scenario-background')) {
      if (step === 1) {
        return {
          kind: 'delegate-subgoal',
          taskTabAlias: 'task-tab-1',
          instruction: 'Click Safe control A',
        };
      }
      return { kind: 'complete', answer: 'Background work finished.' };
    }
    if (currentObjective.includes('scenario-popup')) {
      if (step === 1) {
        return {
          kind: 'delegate-subgoal',
          taskTabAlias: 'task-tab-1',
          instruction: 'Click Open related',
        };
      }
      return { kind: 'complete', answer: 'Popup adopted.' };
    }
    if (currentObjective.includes('scenario-approval')) {
      if (step === 1) {
        return {
          kind: 'delegate-subgoal',
          taskTabAlias: 'task-tab-1',
          instruction: 'Click Buy now',
        };
      }
      return { kind: 'complete', answer: 'Purchase approved.' };
    }
    return { kind: 'complete', answer: 'Unexpected planner call.' };
  });
  const childSteps = new Map<string, number>();
  const childRuntime = new V6AcceptanceModelRuntime((context, instruction) => {
    const step = (childSteps.get(instruction) ?? 0) + 1;
    childSteps.set(instruction, step);
    if (instruction.includes('Safe control A')) {
      if (step === 1) {
        return {
          kind: 'interaction',
          proposal: { kind: 'click', targetId: findNodeByName(context, 'Safe control A').targetId },
        };
      }
      return { kind: 'answer', text: 'Clicked Safe control A.', referencedTargets: [] };
    }
    if (instruction.includes('Open related')) {
      if (step === 1) {
        return {
          kind: 'interaction',
          proposal: { kind: 'click', targetId: findNodeByName(context, 'Open related').targetId },
        };
      }
      return { kind: 'answer', text: 'Opened related tab.', referencedTargets: [] };
    }
    if (instruction.includes('Buy now')) {
      if (step === 1) {
        const buy = context.nodes.find((node) => (node.name ?? '').toLowerCase().includes('buy now'));
        if (!buy?.targetId) {
          throw new Error('Buy now target missing');
        }
        return { kind: 'interaction', proposal: { kind: 'click', targetId: buy.targetId } };
      }
      return { kind: 'answer', text: 'Purchase executed.', referencedTargets: [] };
    }
    return { kind: 'answer', text: 'Child complete.', referencedTargets: [] };
  });

  let taskSeq = 0;
  const chain = createV6ProductChain({
    adapter,
    targetRegistry: adapter.getInteractionTargetRegistry(),
    plannerRuntime,
    childRuntime,
    observationSource: {
      observePage: (tabId, options) => adapter.observePage(tabId, options),
    },
    now: () => Date.now(),
    generateTaskId: () => `task-v6-electron-${++taskSeq}`,
    browserState: {
      get activeTabId() {
        return adapter.getBrowserState().activeTabId;
      },
      set activeTabId(_value: TabId) {
        // Electron adapter owns activation.
      },
    },
  });
  tabCreated.handler = (event) => {
    void chain.controller.handleTabCreated(event).catch(() => {
      // Lifecycle bookkeeping failure must not grant authority.
    });
  };
  invalidation.handler = (tabId, reason) => {
    if (reason === 'navigation') {
      chain.controller.handleGenericNavigation(tabId);
    } else {
      chain.lifecycle.invalidateTab(tabId);
    }
  };

  try {
    const baseUrl = fixture.url.replace(/\/$/, '');

    tabs.a = await adapter.createTab({ url: `${baseUrl}${V6_TWO_SAFE_PATH}` });
    await waitForObservation(adapter, tabs.a);
    window.focus();

    currentObjective = 'scenario-background';
    primitiveCounts.click = 0;
    primitiveCounts.clickOnA = 0;
    const startedBackground = chain.controller.start('scenario-background');
    if (!startedBackground.ok) {
      throw new Error(`background task did not start: ${startedBackground.error?.code ?? 'unknown'}`);
    }
    const backgroundId = startedBackground.task.taskId;
    await waitUntil(
      () => chain.childRuns.getActiveChild(backgroundId) !== undefined,
      30000,
      () =>
        `background child did not start (state=${chain.coordinator.getTask(backgroundId)?.state} planner=${plannerRuntime.requests.length} events=${chain.taskEvents.map((event) => event.type).join(',')})`,
    );
    const tabB = await adapter.createTab({
      url: `${baseUrl}${V6_BACKGROUND_PATH}`,
      activate: true,
    });
    await waitForObservation(adapter, tabB);
    assert.equal(
      adapter.getBrowserState().activeTabId,
      tabB,
      'foreground after creating unrelated tab B',
    );
    await waitUntil(
      () => chain.coordinator.getTask(backgroundId)?.state === 'completed',
      30000,
      () =>
        `background task did not complete (state=${chain.coordinator.getTask(backgroundId)?.state} clicksOnA=${primitiveCounts.clickOnA} terminal=${chain.coordinator.getTask(backgroundId)?.terminalReason})`,
    );
    assert.equal(
      adapter.getBrowserState().activeTabId,
      tabB,
      'foreground after background task completed',
    );
    assert.equal(primitiveCounts.clickOnA >= 1, true, `background clicks on A=${primitiveCounts.clickOnA}`);
    assert.equal(chain.controller.getCompletedDelegationTurns().length, 1);

    await adapter.activateTab(tabs.a);
    await adapter.navigate(tabs.a, `${baseUrl}${V6_POPUP_CLICK_PATH}`);
    await waitForObservation(adapter, tabs.a);
    currentObjective = 'scenario-popup';
    childSteps.clear();
    const startedPopup = chain.controller.start('scenario-popup');
    if (!startedPopup.ok) {
      throw new Error(`popup task did not start: ${startedPopup.error?.code ?? 'unknown'}`);
    }
    const popupTaskId = startedPopup.task.taskId;
    await waitUntil(
      () => chain.childRuns.getActiveChild(popupTaskId) !== undefined,
      30000,
      () => `popup child did not start (state=${chain.coordinator.getTask(popupTaskId)?.state})`,
    );
    await adapter.activateTab(tabB);
    assert.equal(
      adapter.getBrowserState().activeTabId,
      tabB,
      'foreground after switching to B during popup child',
    );
    await waitUntil(
      () => (chain.coordinator.getTask(popupTaskId)?.ownedTabCount ?? 0) >= 2,
      30000,
      () =>
        `causal popup was not adopted (owned=${chain.coordinator.getTask(popupTaskId)?.ownedTabCount} state=${chain.coordinator.getTask(popupTaskId)?.state})`,
    );
    assert.equal(
      adapter.getBrowserState().activeTabId,
      tabB,
      'foreground after causal popup adoption',
    );
    assert.equal(chain.coordinator.getOwnedTabs(popupTaskId).length, 2);
    await waitUntil(
      () => chain.coordinator.getTask(popupTaskId)?.state === 'completed',
      30000,
      () => `popup task did not complete (state=${chain.coordinator.getTask(popupTaskId)?.state})`,
    );
    assert.equal(
      adapter.getBrowserState().activeTabId,
      tabB,
      'foreground after popup task completed',
    );
    await adapter.activateTab(tabs.a);
    await adapter.navigate(tabs.a, `${baseUrl}${V6_CONSEQUENTIAL_PATH}`);
    await waitForObservation(adapter, tabs.a);
    currentObjective = 'scenario-approval';
    childSteps.clear();
    chain.approvalEvents.length = 0;
    primitiveCounts.click = 0;
    const startedApproval = chain.controller.start('scenario-approval');
    if (!startedApproval.ok) {
      throw new Error(`approval task did not start: ${startedApproval.error?.code ?? 'unknown'}`);
    }
    const approvalTaskId = startedApproval.task.taskId;
    await waitUntil(
      () => chain.approvalEvents.some((event) => event.type === 'approval-required'),
      30000,
      () =>
        `approval-required was not emitted (state=${chain.coordinator.getTask(approvalTaskId)?.state} terminal=${chain.coordinator.getTask(approvalTaskId)?.terminalReason} events=${chain.approvalEvents.map((event) => event.type).join(',')})`,
    );
    const pending = lastPendingApproval(chain);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.facts.adapterPrimitiveInvoked, false);
    assert.equal(chain.coordinator.getTask(approvalTaskId)?.state, 'awaiting-approval');
    for (const reply of ['yes', 'approve', 'do it']) {
      const ignored = chain.controller.reply(approvalTaskId, reply);
      assert.equal(ignored.ok, false);
    }
    assert.equal(chain.coordinator.getTask(approvalTaskId)?.state, 'awaiting-approval');
    assert.equal(primitiveCounts.click, 0);
    const approved = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(approved.ok, true, `approve failed: ${'error' in approved ? approved.error.code : ''}`);
    await waitUntil(
      () => chain.manager.getSnapshot(pending.approvalId)?.action.state === 'executed',
      30000,
      () =>
        `approved action was not executed (state=${chain.manager.getSnapshot(pending.approvalId)?.action.state})`,
    );
    assert.equal(primitiveCounts.click, 1);
    await waitUntil(
      () => chain.coordinator.getTask(approvalTaskId)?.state === 'completed',
      30000,
      () => `approval task did not complete (state=${chain.coordinator.getTask(approvalTaskId)?.state})`,
    );
    assert.equal(chain.coordinator.getTask(approvalTaskId)?.taskApprovalCount, 1);

    console.log('[v6-electron-autonomous-task] PASS');
  } finally {
    chain.dispose();
    adapter.dispose();
    if (!window.isDestroyed()) {
      window.close();
    }
    await fixture.close();
  }
}

void run()
  .then(() => {
    app.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[v6-electron-autonomous-task] FAIL');
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    app.exit(1);
  });
