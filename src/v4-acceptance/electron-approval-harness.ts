import assert from 'node:assert/strict';

import { app, BrowserWindow, WebContentsView } from 'electron';

import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import { startObservationFixtureServer } from '../../scripts/observation-fixture-server';
import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';
import {
  V4_AFTER_PURCHASE_PATH,
  V4_CONSEQUENTIAL_PATH,
  V4_NAVIGATE_ACTION_PATH,
  V4_PROMPT_INJECTION_CANARY,
  V4_PROMPT_INJECTION_PATH,
  V4_PURCHASE_NAVIGATED,
  V4_REPLACE_TARGET_PATH,
} from './fixture-constants';
import {
  findNodeByName,
  observationContainsText,
  parseInteractiveContextFromMessages,
} from './context-helpers';
import { createV4ProductChain, waitUntil } from './chain-helpers';
import { RecordingInteractionModelRuntime } from './recording-interaction-model-runtime';

delete process.env.AI_GATEWAY_API_KEY;

interface MarkerState {
  send?: number;
  submit?: number;
  buy?: number;
  purchase?: number;
  delete?: number;
  publish?: number;
  book?: number;
  reserve?: number;
  account?: number;
  inject?: number;
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
    'window.__v4Markers ? JSON.parse(JSON.stringify(window.__v4Markers)) : {}',
  );
  return (raw ?? {}) as MarkerState;
}

function lastPending(events: Array<{ type: string; approval?: { approvalId: string } }>) {
  const event = [...events].reverse().find((entry) => entry.type === 'approval-required');
  assert.ok(event, 'expected approval-required event');
  assert.equal(event.type, 'approval-required');
  if (event.type !== 'approval-required' || !('approval' in event) || !event.approval) {
    throw new Error('expected approval-required');
  }
  return event.approval as { approvalId: string; description?: string; title: string };
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
    onTabInvalidated: (tabId) => {
      invalidation.handler(tabId);
    },
  });
  const primitiveCounts = { click: 0, type: 0 };
  const originalClick = adapter.click.bind(adapter);
  const originalType = adapter.type.bind(adapter);
  Reflect.set(adapter, 'click', async (request: Parameters<ElectronBrowserAdapter['click']>[0]) => {
    primitiveCounts.click += 1;
    return originalClick(request);
  });
  Reflect.set(adapter, 'type', async (request: Parameters<ElectronBrowserAdapter['type']>[0]) => {
    primitiveCounts.type += 1;
    return originalType(request);
  });

  const runtime = new RecordingInteractionModelRuntime((context, instruction) => {
    const lower = instruction.toLowerCase();
    if (lower.includes('password')) {
      return {
        kind: 'interaction',
        proposal: {
          kind: 'type',
          targetId: findNodeByName(context, 'Password').targetId,
          text: 'should-not-type',
        },
      };
    }
    if (lower.includes('canary') || lower.includes('injection')) {
      return {
        kind: 'interaction',
        proposal: {
          kind: 'click',
          targetId: findNodeByName(context, V4_PROMPT_INJECTION_CANARY).targetId,
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

  const chain = createV4ProductChain({
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

    const tabId = await adapter.createTab({ url: `${baseUrl}${V4_CONSEQUENTIAL_PATH}` });
    await waitForObservation(adapter, tabId);
    window.focus();

    primitiveCounts.click = 0;
    let markers = await readMarkers(window);
    assert.equal(markers.buy ?? 0, 0);

    const rejectStart = chain.aiController.startAsk(tabId, 'Buy now', 'interact');
    assert.equal(rejectStart.ok, true);
    await waitUntil(() =>
      chain.aiEvents.some((event) => event.type === 'interaction-approval-required'),
    );
    const rejectPending = lastPending(chain.events);
    const rejectSnapshot = chain.manager.getSnapshot(rejectPending.approvalId);
    assert.equal(rejectSnapshot?.action.state, 'pending');
    assert.equal(rejectSnapshot?.facts.grantClaimed, false);
    assert.equal(rejectSnapshot?.facts.adapterPrimitiveInvoked, false);
    assert.equal(primitiveCounts.click, 0);
    markers = await readMarkers(window);
    assert.equal(markers.buy ?? 0, 0);
    const approvalRequired = chain.aiEvents.find(
      (event) => event.type === 'interaction-approval-required',
    );
    assert.equal(JSON.stringify(approvalRequired).includes('approvalId'), false);
    assert.equal(JSON.stringify(approvalRequired).includes('targetId'), false);

    const rejected = await chain.workflow.decide({
      approvalId: rejectPending.approvalId,
      decision: 'reject',
    });
    assert.equal(rejected.ok, true);
    assert.equal(chain.manager.getSnapshot(rejectPending.approvalId)?.action.state, 'rejected');
    assert.equal(primitiveCounts.click, 0);
    markers = await readMarkers(window);
    assert.equal(markers.buy ?? 0, 0);

    const approveResult = await chain.agent.interact({ tabId, instruction: 'Buy now' });
    assert.equal(approveResult.kind, 'interaction');
    if (approveResult.kind === 'interaction') {
      assert.deepEqual(approveResult.result, { status: 'approval-required' });
    }
    const approvePending = lastPending(chain.events);
    markers = await readMarkers(window);
    assert.equal(markers.buy ?? 0, 0);
    assert.equal(primitiveCounts.click, 0);

    const approved = await chain.workflow.decide({
      approvalId: approvePending.approvalId,
      decision: 'approve',
    });
    assert.equal(approved.ok, true, 'approve decision should succeed');
    await waitUntil(
      () => chain.manager.getSnapshot(approvePending.approvalId)?.action.state === 'executed',
    );
    const executed = chain.manager.getSnapshot(approvePending.approvalId);
    assert.equal(executed?.action.state, 'executed', `state=${executed?.action.state}`);
    assert.equal(executed?.facts.grantIssued, true, 'grantIssued');
    assert.equal(executed?.facts.grantClaimed, true, 'grantClaimed');
    assert.equal(executed?.facts.adapterPrimitiveInvoked, true, 'adapterPrimitiveInvoked');
    assert.equal(executed?.facts.postObservationSucceeded, true, 'postObservationSucceeded');
    assert.equal(primitiveCounts.click, 1, `click count after approve=${primitiveCounts.click}`);
    await waitUntil(async () => ((await readMarkers(window)).buy ?? 0) >= 1);
    markers = await readMarkers(window);
    assert.equal(markers.buy, 1, `buy marker after approve=${JSON.stringify(markers)}`);

    const duplicate = await chain.workflow.decide({
      approvalId: approvePending.approvalId,
      decision: 'approve',
    });
    assert.equal(duplicate.ok, false);
    assert.equal(primitiveCounts.click, 1);
    markers = await readMarkers(window);
    assert.equal(markers.buy, 1);

    await adapter.navigate(tabId, `${baseUrl}${V4_PROMPT_INJECTION_PATH}`);
    await waitForObservation(adapter, tabId);
    primitiveCounts.click = 0;
    const injectResult = await chain.agent.interact({
      tabId,
      instruction: 'Click the canary injection button',
    });
    assert.equal(injectResult.kind, 'interaction');
    if (injectResult.kind === 'interaction') {
      assert.deepEqual(injectResult.result, { status: 'approval-required' });
    }
    const injectPending = lastPending(chain.events);
    assert.match(
      `${injectPending.title} ${injectPending.description ?? ''}`,
      new RegExp(V4_PROMPT_INJECTION_CANARY),
    );
    assert.equal(chain.manager.getSnapshot(injectPending.approvalId)?.action.state, 'pending');
    const injectMarkers = await readMarkers(window);
    assert.equal(injectMarkers.inject ?? 0, 0);
    assert.equal(primitiveCounts.click, 0);

    await adapter.navigate(tabId, `${baseUrl}${V4_CONSEQUENTIAL_PATH}`);
    await waitForObservation(adapter, tabId);
    primitiveCounts.click = 0;
    await chain.agent.interact({ tabId, instruction: 'Buy now' });
    const navPending = lastPending(chain.events);
    assert.equal((await readMarkers(window)).buy ?? 0, 0);
    await getActiveWebContents(window).executeJavaScript(
      `window.__v4SelfNavigate(${JSON.stringify(`${baseUrl}${V4_AFTER_PURCHASE_PATH}`)})`,
    );
    await waitUntil(() =>
      chain.manager.getSnapshot(navPending.approvalId)?.action.state === 'stale',
    );
    const navDecision = await chain.workflow.decide({
      approvalId: navPending.approvalId,
      decision: 'approve',
    });
    assert.equal(navDecision.ok, false);
    assert.equal(primitiveCounts.click, 0);

    await adapter.navigate(tabId, `${baseUrl}${V4_REPLACE_TARGET_PATH}`);
    await waitForObservation(adapter, tabId);
    primitiveCounts.click = 0;
    await chain.agent.interact({ tabId, instruction: 'Buy now' });
    const replacePending = lastPending(chain.events);
    await getActiveWebContents(window).executeJavaScript('window.__v4ReplaceBuyButton()');
    await waitForObservation(adapter, tabId);
    const replaceDecision = await chain.workflow.decide({
      approvalId: replacePending.approvalId,
      decision: 'approve',
    });
    assert.equal(replaceDecision.ok, true);
    assert.equal(chain.manager.getSnapshot(replacePending.approvalId)?.action.state, 'stale');
    assert.equal(primitiveCounts.click, 0);
    assert.equal((await readMarkers(window)).buy ?? 0, 0);

    await adapter.navigate(tabId, `${baseUrl}${V4_NAVIGATE_ACTION_PATH}`);
    await waitForObservation(adapter, tabId);
    primitiveCounts.click = 0;
    await chain.agent.interact({ tabId, instruction: 'Buy now' });
    const purchasePending = lastPending(chain.events);
    const purchaseApproved = await chain.workflow.decide({
      approvalId: purchasePending.approvalId,
      decision: 'approve',
    });
    assert.equal(purchaseApproved.ok, true);
    const purchaseState = chain.manager.getSnapshot(purchasePending.approvalId);
    assert.equal(purchaseState?.action.state, 'executed');
    assert.notEqual(purchaseState?.action.state, 'stale');
    assert.equal(purchaseState?.facts.adapterPrimitiveInvoked, true);
    assert.equal(purchaseState?.facts.postObservationSucceeded, true);
    assert.equal(primitiveCounts.click, 1);
    const afterPurchase = await waitForObservation(adapter, tabId);
    assert.equal(
      observationContainsText(afterPurchase.nodes, V4_PURCHASE_NAVIGATED) ||
        afterPurchase.document.url.includes('after-purchase'),
      true,
    );

    const extraTab = await adapter.createTab({ url: `${baseUrl}${V4_CONSEQUENTIAL_PATH}` });
    await waitForObservation(adapter, extraTab);
    primitiveCounts.click = 0;
    await chain.agent.interact({ tabId: extraTab, instruction: 'Buy now' });
    const closePending = lastPending(chain.events);
    await adapter.closeTab(extraTab);
    await waitUntil(
      () => chain.manager.getSnapshot(closePending.approvalId)?.action.state === 'stale',
    );
    const closeDecision = await chain.workflow.decide({
      approvalId: closePending.approvalId,
      decision: 'approve',
    });
    assert.equal(closeDecision.ok, false);
    assert.equal(primitiveCounts.click, 0);

    const request = runtime.requests[0];
    assert.ok(request);
    const parsed = parseInteractiveContextFromMessages(request.messages);
    assert.equal(findNodeByName(parsed, 'Buy now').targetId.length > 0, true);
    assert.equal(JSON.stringify(runtime.requests).includes('approvalId'), false);
    assert.equal(JSON.stringify(runtime.requests).includes('ExecuteGrant'), false);

    console.log('[v4-electron-approval] PASS');
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
    console.error('[v4-electron-approval] FAIL');
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    app.exit(1);
  });
