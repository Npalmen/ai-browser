import assert from 'node:assert/strict';

import { app, BrowserWindow, WebContentsView } from 'electron';

import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import { startObservationFixtureServer } from '../../scripts/observation-fixture-server';
import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';
import {
  createV5ProductChain,
  lastPendingApproval,
  waitUntil,
} from './chain-helpers';
import {
  V5_AFTER_PURCHASE_PATH,
  V5_MULTI_STEP_PATH,
  V5_NAVIGATE_ACTION_PATH,
  V5_SAFE_NAV_A_PATH,
  V5_TWO_SAFE_PATH,
} from './fixture-constants';
import { findNodeByName, observationContainsText } from './context-helpers';
import { V5AcceptanceModelRuntime } from './recording-agent-model-runtime';

delete process.env.AI_GATEWAY_API_KEY;

interface MarkerState {
  safeA?: number;
  safeB?: number;
  buy?: number;
  publish?: number;
  typed?: number;
}

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

function getActiveWebContents(window: BrowserWindow) {
  for (const child of window.contentView.children) {
    if (child instanceof WebContentsView) {
      return child.webContents;
    }
  }
  throw new Error('No active WebContentsView found');
}

async function readMarkers(window: BrowserWindow): Promise<MarkerState> {
  const raw = await getActiveWebContents(window).executeJavaScript(
    'window.__v5Markers ? JSON.parse(JSON.stringify(window.__v5Markers)) : {}',
  );
  return (raw ?? {}) as MarkerState;
}

function createScenarioRuntime() {
  const counters = new Map<string, number>();
  const runtime = new V5AcceptanceModelRuntime((context, instruction) => {
    const url = context.document.url;
    const step = counters.get(instruction) ?? 0;
    counters.set(instruction, step + 1);

    if (instruction.includes('scenario-a')) {
      if (step === 0) {
        return {
          kind: 'interaction',
          proposal: {
            kind: 'click',
            targetId: findNodeByName(context, 'Safe control A').targetId,
          },
        };
      }
      if (step === 1) {
        return {
          kind: 'interaction',
          proposal: {
            kind: 'click',
            targetId: findNodeByName(context, 'Safe control B').targetId,
          },
        };
      }
      return { kind: 'answer', text: 'Scenario A complete.', referencedTargets: [] };
    }

    if (instruction.includes('scenario-b')) {
      if (url.includes('safe-navigation-a')) {
        return {
          kind: 'interaction',
          proposal: {
            kind: 'click',
            targetId: findNodeByName(context, 'Next').targetId,
          },
        };
      }
      if (url.includes('safe-navigation-b')) {
        const pageBStep = counters.get('scenario-b-page-b') ?? 0;
        counters.set('scenario-b-page-b', pageBStep + 1);
        if (pageBStep === 0) {
          return {
            kind: 'interaction',
            proposal: {
              kind: 'click',
              targetId: findNodeByName(context, 'Safe control B').targetId,
            },
          };
        }
        return { kind: 'answer', text: 'Scenario B complete.', referencedTargets: [] };
      }
      throw new Error(`Unexpected scenario-b page: ${url}`);
    }

    if (instruction.includes('scenario-c')) {
      if (step === 0) {
        return {
          kind: 'interaction',
          proposal: {
            kind: 'click',
            targetId: findNodeByName(context, 'Safe control A').targetId,
          },
        };
      }
      if (step === 1) {
        return {
          kind: 'interaction',
          proposal: {
            kind: 'click',
            targetId: findNodeByName(context, 'Buy now').targetId,
          },
        };
      }
      return { kind: 'answer', text: 'Scenario C complete.', referencedTargets: [] };
    }

    if (instruction.includes('navigate-action')) {
      return {
        kind: 'interaction',
        proposal: {
          kind: 'click',
          targetId: findNodeByName(context, 'Buy now').targetId,
        },
      };
    }

    return {
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Buy now').targetId,
      },
    };
  });
  return {
    runtime,
    resetScenarioCounters: () => {
      counters.clear();
    },
  };
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

  const invalidation = {
    handler: (_tabId: TabId) => {
      // Assigned after the product chain is created.
    },
  };
  const adapter = new ElectronBrowserAdapter(window, {
    onTabInvalidated: (tabId, reason) => {
      if (reason !== 'navigation') {
        invalidation.handler(tabId);
      }
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
  const primitiveCounts = { click: 0 };
  const originalClick = adapter.click.bind(adapter);
  Reflect.set(adapter, 'click', async (request: Parameters<ElectronBrowserAdapter['click']>[0]) => {
    primitiveCounts.click += 1;
    const before = await adapter.getPageState(request.target.tabId);
    const result = await originalClick(request);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const after = await adapter.getPageState(request.target.tabId);
      if (!after.loading) {
        if (after.url.includes('safe-navigation-b')) {
          const observation = await originalObservePage(request.target.tabId);
          if (
            observation.nodes.some((node) =>
              (node.name ?? '').toLowerCase().includes('safe control b'),
            )
          ) {
            break;
          }
        } else if (after.url !== before.url || after.url === before.url) {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return result;
  });

  const { runtime, resetScenarioCounters } = createScenarioRuntime();
  const chain = createV5ProductChain({
    adapter,
    targetRegistry: adapter.getInteractionTargetRegistry(),
    runtime,
    observationSource: {
      observePage: (tabId, options) => adapter.observePage(tabId, options),
    },
    now: () => Date.now(),
  });
  invalidation.handler = (tabId) => {
    chain.lifecycle.invalidateTab(tabId);
  };

  try {
    const baseUrl = fixture.url.replace(/\/$/, '');

    // Scenario A — two safe actions then answer
    const tabA = await adapter.createTab({ url: `${baseUrl}${V5_TWO_SAFE_PATH}` });
    await waitForObservation(adapter, tabA);
    window.focus();
    primitiveCounts.click = 0;
    const startA = chain.aiController.startAsk(tabA, 'scenario-a', 'interact');
    assert.equal(startA.ok, true);
    await waitUntil(
      () => chain.aiEvents.some((event) => event.type === 'agent-run-completed'),
      30000,
    );
    const startedEventA = chain.aiEvents.find((event) => event.type === 'agent-run-started');
    assert.ok(startedEventA);
    const completedA = chain.aiEvents.find((event) => event.type === 'agent-run-completed');
    assert.ok(completedA);
    assert.equal(
      completedA?.type === 'agent-run-completed' && completedA.answer.text,
      'Scenario A complete.',
    );
    const runA = chain.agentRunCoordinator.getRun(startedEventA.runId);
    assert.ok(runA);
    assert.equal(runA?.modelStepCount, 3);
    assert.equal(runA?.actionAttemptCount, 2);
    assert.equal(runA?.approvalCount, 0);
    let markers = await readMarkers(window);
    assert.equal(markers.safeA, 1, `scenario A safeA marker=${markers.safeA}`);
    assert.equal(markers.safeB, 1, `scenario A safeB marker=${markers.safeB}`);
    assert.equal(chain.approvalEvents.some((e) => e.type === 'approval-required'), false);
    const storedA = chain.conversationStore.get(tabA);
    assert.equal(storedA?.turns.length, 1);
    assert.equal(storedA?.turns[0]?.question, 'scenario-a');
    assert.equal(storedA?.turns[0]?.answer, 'Scenario A complete.');

    // Scenario B — safe navigation continues
    await adapter.navigate(tabA, `${baseUrl}${V5_SAFE_NAV_A_PATH}`);
    await waitForObservation(adapter, tabA);
    await new Promise((resolve) => setTimeout(resolve, 250));
    resetScenarioCounters();
    primitiveCounts.click = 0;
    chain.aiEvents.length = 0;
    const startB = chain.aiController.startAsk(tabA, 'scenario-b', 'interact');
    assert.equal(startB.ok, true);
    await waitUntil(
      () =>
        chain.aiEvents.some(
          (event) =>
            event.type === 'agent-run-completed' ||
            event.type === 'agent-run-blocked' ||
            event.type === 'agent-run-failed' ||
            event.type === 'agent-run-cancelled',
        ),
      30000,
    );
    const terminalB = chain.aiEvents.find(
      (event) =>
        event.type === 'agent-run-completed' ||
        event.type === 'agent-run-blocked' ||
        event.type === 'agent-run-failed' ||
        event.type === 'agent-run-cancelled',
    );
    assert.equal(terminalB?.type, 'agent-run-completed', JSON.stringify(chain.aiEvents));
    markers = await readMarkers(window);
    assert.equal(markers.safeB, 1, `scenario B safeB marker=${markers.safeB}`);
    const startedEventB = chain.aiEvents.find((event) => event.type === 'agent-run-started');
    assert.ok(startedEventB);
    const runB = chain.agentRunCoordinator.getRun(startedEventB.runId);
    assert.equal(runB?.state, 'completed');

    // Scenario C — safe action, approval, resume, answer
    await adapter.navigate(tabA, `${baseUrl}${V5_MULTI_STEP_PATH}`);
    await waitForObservation(adapter, tabA);
    primitiveCounts.click = 0;
    chain.aiEvents.length = 0;
    chain.approvalEvents.length = 0;
    const modelRequestsBeforeC = runtime.requests.length;
    const startC = chain.aiController.startAsk(tabA, 'scenario-c', 'interact');
    assert.equal(startC.ok, true);
    await waitUntil(() =>
      chain.aiEvents.some((event) => event.type === 'agent-run-awaiting-approval'),
    );
    const pendingC = lastPendingApproval(chain);
    const pendingSnapshot = chain.manager.getSnapshot(pendingC.approvalId);
    assert.equal(pendingSnapshot?.action.state, 'pending');
    assert.equal(pendingSnapshot?.facts.grantClaimed, false);
    assert.equal(pendingSnapshot?.facts.adapterPrimitiveInvoked, false);
    assert.equal(primitiveCounts.click, 1);
    markers = await readMarkers(window);
    assert.equal(markers.buy ?? 0, 0);
    assert.equal(runtime.requests.length - modelRequestsBeforeC, 2);

    const approvedC = await chain.workflow.decide({
      approvalId: pendingC.approvalId,
      decision: 'approve',
    });
    assert.equal(approvedC.ok, true);
    await waitUntil(
      () => chain.manager.getSnapshot(pendingC.approvalId)?.action.state === 'executed',
    );
    const executedC = chain.manager.getSnapshot(pendingC.approvalId);
    assert.equal(executedC?.facts.postObservationSucceeded, true);
    assert.equal(primitiveCounts.click, 2);
    markers = await readMarkers(window);
    assert.equal(markers.buy, 1);
    await waitUntil(() =>
      chain.aiEvents.some((event) => event.type === 'agent-run-completed'),
    );
    const startedEventC = chain.aiEvents.find((event) => event.type === 'agent-run-started');
    assert.ok(startedEventC);
    const runC = chain.agentRunCoordinator.getRun(startedEventC.runId);
    assert.equal(runC?.modelStepCount, 3);
    assert.equal(runC?.actionAttemptCount, 3);
    assert.equal(runC?.approvalCount, 1);
    assert.equal(runtime.requests.length - modelRequestsBeforeC, 3);

    // Approved navigation action
    await adapter.navigate(tabA, `${baseUrl}${V5_NAVIGATE_ACTION_PATH}`);
    await waitForObservation(adapter, tabA);
    primitiveCounts.click = 0;
    chain.aiEvents.length = 0;
    chain.approvalEvents.length = 0;
    const startNav = chain.aiController.startAsk(tabA, 'navigate-action', 'interact');
    assert.equal(startNav.ok, true);
    await waitUntil(() =>
      chain.aiEvents.some((event) => event.type === 'agent-run-awaiting-approval'),
    );
    const pendingNav = lastPendingApproval(chain);
    const navApproved = await chain.workflow.decide({
      approvalId: pendingNav.approvalId,
      decision: 'approve',
    });
    assert.equal(navApproved.ok, true);
    await waitUntil(
      () => chain.manager.getSnapshot(pendingNav.approvalId)?.action.state === 'executed',
    );
    const navExecuted = chain.manager.getSnapshot(pendingNav.approvalId);
    assert.notEqual(navExecuted?.action.state, 'stale');
    assert.equal(navExecuted?.facts.adapterPrimitiveInvoked, true);
    const afterNav = await waitForObservation(adapter, tabA);
    assert.equal(
      observationContainsText(afterNav.nodes, 'after purchase') ||
        afterNav.document.url.includes('after-purchase'),
      true,
    );

    console.log('[v5-electron-agent-loop] PASS');
  } finally {
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
    console.error('[v5-electron-agent-loop] FAIL');
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    app.exit(1);
  });
