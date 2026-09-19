import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, WebContentsView } from 'electron';

import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import type { BrowserTabCreatedEvent } from '../browser/tab-creation';
import { PersistentWorkflowRuntime } from '../main/persistent-workflow-runtime';
import { WORKFLOW_STORE_CANONICAL_FILENAME } from '../main/workflow-store';
import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';
import { InteractionError } from '../shared/interaction-errors';
import { startObservationFixtureServer } from '../../scripts/observation-fixture-server';
import {
  createV6ProductChain,
  lastPendingApproval,
  waitUntil,
} from '../v6-acceptance/chain-helpers';
import {
  V6_BACKGROUND_PATH,
  V6_CONSEQUENTIAL_PATH,
  V6_TWO_SAFE_PATH,
} from '../v6-acceptance/fixture-constants';
import { findNodeByName } from '../v6-acceptance/context-helpers';
import { RecordingPlannerRuntime } from '../v6-acceptance/recording-planner-runtime';
import { V6AcceptanceModelRuntime } from '../v6-acceptance/recording-agent-model-runtime';
import { bindRuntimeToController, FakeTimer } from './runtime-helpers';

delete process.env.AI_GATEWAY_API_KEY;

type ProductChain = ReturnType<typeof createV6ProductChain>;

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
  throw new Error(`Timed out waiting for page observation (${tabId})`);
}

function websiteViews(window: BrowserWindow): WebContentsView[] {
  return window.contentView.children.filter((child): child is WebContentsView => child instanceof WebContentsView);
}

async function readFixtureState(
  window: BrowserWindow,
  urlNeedle: string,
  expression: string,
): Promise<unknown> {
  for (const view of websiteViews(window)) {
    if (view.webContents.isDestroyed()) {
      continue;
    }
    const url = view.webContents.getURL();
    if (!url.includes(urlNeedle)) {
      continue;
    }
    return view.webContents.executeJavaScript(expression);
  }
  throw new Error(`No fixture view matching ${urlNeedle}`);
}

async function run(): Promise<void> {
  assert.equal(process.env.AI_GATEWAY_API_KEY, undefined);
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.disableHardwareAcceleration();
  const userData = mkdtempSync(path.join(os.tmpdir(), 'v7-electron-userdata-'));
  const storeDirectory = path.join(userData, 'workflows');
  mkdirSync(storeDirectory, { recursive: true });
  app.setPath('userData', userData);
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

  const primitiveCounts = { click: 0 };
  let clickMode: 'pass' | 'throw-after' = 'pass';
  const originalClick = adapter.click.bind(adapter);
  Reflect.set(adapter, 'click', async (request: Parameters<ElectronBrowserAdapter['click']>[0]) => {
    primitiveCounts.click += 1;
    const result = await originalClick(request);
    if (clickMode === 'throw-after') {
      throw new InteractionError('INTERACTION_FAILED', 'post-dispatch unknown');
    }
    return result;
  });

  let currentObjective = '';
  const plannerSteps = new Map<string, number>();
  const plannerRuntime = new RecordingPlannerRuntime(() => {
    const step = (plannerSteps.get(currentObjective) ?? 0) + 1;
    plannerSteps.set(currentObjective, step);
    if (currentObjective.includes('hold-child')) {
      return {
        kind: 'delegate-subgoal',
        taskTabAlias: 'task-tab-1',
        instruction: 'Click Safe control A',
      };
    }
    if (step === 1) {
      return {
        kind: 'delegate-subgoal',
        taskTabAlias: 'task-tab-1',
        instruction: currentObjective.includes('Buy now') ? 'Click Buy now' : 'Click Safe control A',
      };
    }
    return { kind: 'complete', answer: 'Workflow child finished.' };
  });
  const childSteps = new Map<string, number>();
  let holdChild = false;
  const childRuntime = new V6AcceptanceModelRuntime((context, instruction) => {
    if (holdChild) {
      return new Promise(() => {
        // Intentionally unfinished so the occurrence stays running.
      });
    }
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

  const live: {
    runtime: PersistentWorkflowRuntime | undefined;
    chain: ProductChain | undefined;
    forward: boolean;
    taskSeq: number;
  } = {
    runtime: undefined,
    chain: undefined,
    forward: true,
    taskSeq: 0,
  };

  const wireChainHandlers = () => {
    tabCreated.handler = (event) => {
      void live.chain?.controller.handleTabCreated(event).catch(() => undefined);
    };
    invalidation.handler = (tabId, reason) => {
      if (!live.chain) {
        return;
      }
      if (reason === 'navigation') {
        live.chain.controller.handleGenericNavigation(tabId);
      } else {
        live.chain.lifecycle.invalidateTab(tabId);
      }
    };
  };

  const disposeLive = (forward = true) => {
    live.forward = forward;
    live.runtime?.dispose();
    live.chain?.dispose();
    live.runtime = undefined;
    live.chain = undefined;
    live.forward = true;
  };

  const startLive = async (sessionId: string) => {
    disposeLive(false);
    const runtime = await PersistentWorkflowRuntime.initialize({
      directory: storeDirectory,
      runtimeSessionId: sessionId,
      timer: new FakeTimer(),
    });
    live.runtime = runtime;
    live.forward = true;
    live.taskSeq = 0;
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: adapter.getInteractionTargetRegistry(),
      plannerRuntime,
      childRuntime,
      observationSource: {
        observePage: (tabId, options) => adapter.observePage(tabId, options),
      },
      now: () => Date.now(),
      generateTaskId: () => `task-v7-electron-${sessionId}-${++live.taskSeq}`,
      emitTask: (event) => {
        if (live.forward) {
          live.runtime?.handleAutonomousTaskEvent(event);
        }
      },
      browserState: {
        get activeTabId() {
          return adapter.getBrowserState().activeTabId;
        },
        set activeTabId(_value: TabId) {
          // Electron adapter owns activation.
        },
        get tabs() {
          return adapter.getBrowserState().tabs;
        },
      },
    });
    live.chain = chain;
    bindRuntimeToController(runtime, chain.controller, adapter);
    wireChainHandlers();
    return { runtime, chain };
  };

  try {
    const baseUrl = fixture.url.replace(/\/$/, '');
    const userTab = await adapter.createTab({ url: `${baseUrl}${V6_BACKGROUND_PATH}` });
    await waitForObservation(adapter, userTab);
    window.focus();
    assert.equal(adapter.getBrowserState().activeTabId, userTab);

    // A — persist definition, reconstruct runtime, no restored live authority.
    const runtimeA = await PersistentWorkflowRuntime.initialize({
      directory: storeDirectory,
      runtimeSessionId: 'electron-A',
      timer: new FakeTimer(),
    });
    const persisted = await runtimeA.createWorkflow({
      name: 'Persist Electron',
      objective: 'Click Safe control A',
      entryPoint: { kind: 'url', url: `${baseUrl}${V6_TWO_SAFE_PATH}` },
      trigger: { kind: 'manual' },
    });
    const canonical = JSON.parse(
      await fs.readFile(path.join(storeDirectory, WORKFLOW_STORE_CANONICAL_FILENAME), 'utf8'),
    ) as { workflows: Array<Record<string, unknown>>; occurrences: Array<Record<string, unknown>> };
    assert.equal(canonical.workflows[0]?.workflowId, persisted.workflowId);
    assert.equal(canonical.workflows[0]?.tabId, undefined);
    assert.equal(canonical.workflows[0]?.taskId, undefined);
    runtimeA.dispose();

    const runtimeA2 = await PersistentWorkflowRuntime.initialize({
      directory: storeDirectory,
      runtimeSessionId: 'electron-A2',
      timer: new FakeTimer(),
    });
    const restored = await runtimeA2.getCoordinator()?.getWorkflow(persisted.workflowId);
    assert.equal(restored?.workflowId, persisted.workflowId);
    assert.equal(restored?.objective, 'Click Safe control A');
    assert.equal(restored?.entryPoint.url, `${baseUrl}${V6_TWO_SAFE_PATH}`);
    assert.notEqual(runtimeA2.runtimeSessionId, runtimeA.runtimeSessionId);
    runtimeA2.dispose();
    assert.equal(adapter.getBrowserState().tabs.some((tab) => tab.id === userTab), true);

    // E — queued occurrence survives and starts once with a fresh tab/task.
    const runtimeE1 = await PersistentWorkflowRuntime.initialize({
      directory: storeDirectory,
      runtimeSessionId: 'electron-E1',
      timer: new FakeTimer(),
    });
    const queuedWorkflow = await runtimeE1.createWorkflow({
      name: 'Queued Electron',
      objective: 'Click Safe control A',
      entryPoint: { kind: 'url', url: `${baseUrl}${V6_TWO_SAFE_PATH}` },
      trigger: { kind: 'manual' },
    });
    const queued = await runtimeE1.runWorkflowNow(queuedWorkflow.workflowId);
    assert.equal(queued.state, 'queued');
    runtimeE1.dispose();

    currentObjective = 'queued-safe';
    childSteps.clear();
    plannerSteps.clear();
    primitiveCounts.click = 0;
    const liveE = await startLive('electron-E2');
    await liveE.runtime.flush();
    await waitUntil(
      async () => (await liveE.runtime.getCoordinator()?.getOccurrence(queued.occurrenceId))?.state === 'completed',
      30000,
      () =>
        `queued occurrence did not complete (planner=${plannerRuntime.requests.length} clicks=${primitiveCounts.click} tabs=${adapter.getBrowserState().tabs.length} live=${liveE.runtime.getRunner()?.inspectLiveExecution()?.taskId ?? 'none'})`,
    );
    const workflowTabE = adapter.getBrowserState().tabs.find((tab) => tab.id !== userTab)?.id;
    assert.ok(workflowTabE);
    assert.notEqual(workflowTabE, userTab);
    assert.equal(adapter.getBrowserState().activeTabId, userTab);
    const markers = (await readFixtureState(
      window,
      V6_TWO_SAFE_PATH,
      'window.__v5Markers',
    )) as { safeA: number };
    assert.equal(markers.safeA >= 1, true, `fixture safeA=${markers.safeA}`);
    assert.equal(primitiveCounts.click >= 1, true);
    const liveAfterE = liveE.runtime.getRunner()?.inspectLiveExecution();
    assert.equal(liveAfterE, undefined);

    // B is covered by E: background workflow tab, foreground user tab, production click.

    // C — consequential approval, free-text cannot approve, one trusted click.
    currentObjective = 'Click Buy now';
    childSteps.clear();
    plannerSteps.clear();
    primitiveCounts.click = 0;
    const buyWorkflow = await liveE.runtime.createWorkflow({
      name: 'Buy Electron',
      objective: 'Click Buy now',
      entryPoint: { kind: 'url', url: `${baseUrl}${V6_CONSEQUENTIAL_PATH}` },
      trigger: { kind: 'manual' },
    });
    const buyOccurrence = await liveE.runtime.runWorkflowNow(buyWorkflow.workflowId);
    await liveE.runtime.flush();
    await waitUntil(
      () => (liveE.chain.approvalEvents ?? []).some((event) => event.type === 'approval-required'),
      30000,
      () =>
        `approval-required missing (events=${liveE.chain.approvalEvents.map((event) => event.type).join(',')})`,
    );
    const pending = lastPendingApproval(liveE.chain);
    assert.equal(liveE.chain.manager.getSnapshot(pending.approvalId)?.facts.adapterPrimitiveInvoked, false);
    const buyMarkersBefore = (await readFixtureState(
      window,
      V6_CONSEQUENTIAL_PATH,
      'window.__v4Markers',
    )) as { buy: number };
    assert.equal(buyMarkersBefore.buy, 0);
    assert.equal(primitiveCounts.click, 0);
    const liveBuy = liveE.runtime.getRunner()?.inspectLiveExecution();
    assert.ok(liveBuy);
    for (const reply of ['yes', 'approve', 'do it']) {
      assert.equal(liveE.chain.controller.reply(liveBuy.taskId, reply).ok, false);
    }
    assert.equal((await liveE.runtime.getCoordinator()?.getOccurrence(buyOccurrence.occurrenceId))?.state, 'running');
    const approved = await liveE.chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(approved.ok, true, `approve failed: ${'error' in approved ? approved.error.code : ''}`);
    await waitUntil(
      async () =>
        (await liveE.runtime.getCoordinator()?.getOccurrence(buyOccurrence.occurrenceId))?.state === 'completed',
      30000,
      () => `buy occurrence did not complete (clicks=${primitiveCounts.click})`,
    );
    assert.equal(primitiveCounts.click, 1);
    const buyMarkersAfter = (await readFixtureState(
      window,
      V6_CONSEQUENTIAL_PATH,
      'window.__v4Markers',
    )) as { buy: number };
    assert.equal(buyMarkersAfter.buy, 1);
    assert.equal(adapter.getBrowserState().activeTabId, userTab);

    // D — running occurrence reconstructs to interrupted with zero replay.
    holdChild = true;
    currentObjective = 'hold-child';
    childSteps.clear();
    plannerSteps.clear();
    const clicksBeforeHold = primitiveCounts.click;
    const holdWorkflow = await liveE.runtime.createWorkflow({
      name: 'Hold Electron',
      objective: 'hold-child work',
      entryPoint: { kind: 'url', url: `${baseUrl}${V6_TWO_SAFE_PATH}` },
      trigger: { kind: 'manual' },
    });
    const holdOccurrence = await liveE.runtime.runWorkflowNow(holdWorkflow.workflowId);
    await liveE.runtime.flush();
    await waitUntil(
      async () => (await liveE.runtime.getCoordinator()?.getOccurrence(holdOccurrence.occurrenceId))?.state === 'running',
      30000,
      () => 'hold occurrence did not become running',
    );
    const oldLive = liveE.runtime.getRunner()?.inspectLiveExecution();
    assert.ok(oldLive);
    const oldTabId = oldLive.tabId;
    const oldTaskId = oldLive.taskId;
    live.forward = false;
    liveE.runtime.dispose();
    liveE.chain.dispose();
    live.runtime = undefined;
    live.chain = undefined;
    holdChild = false;

    const recovered = await PersistentWorkflowRuntime.initialize({
      directory: storeDirectory,
      runtimeSessionId: 'electron-D',
      timer: new FakeTimer(),
    });
    const interrupted = await recovered.getCoordinator()?.getOccurrence(holdOccurrence.occurrenceId);
    assert.equal(interrupted?.state, 'interrupted');
    assert.equal((await recovered.getCoordinator()?.getWorkflow(holdWorkflow.workflowId))?.reviewRequired, true);
    recovered.dispose();

    currentObjective = 'should-not-replay';
    const replay = await startLive('electron-D2');
    await replay.runtime.flush();
    assert.equal(primitiveCounts.click, clicksBeforeHold);
    assert.equal(replay.runtime.getRunner()?.inspectLiveExecution(), undefined);
    const stillInterrupted = await replay.runtime.getCoordinator()?.getOccurrence(holdOccurrence.occurrenceId);
    assert.equal(stillInterrupted?.state, 'interrupted');
    assert.notEqual(oldTabId, userTab);
    assert.ok(oldTaskId.startsWith('task-v7-electron-'));

    // Unknown — one post-dispatch click, no retry after reconstruction.
    clickMode = 'throw-after';
    currentObjective = 'Click Buy now unknown';
    childSteps.clear();
    plannerSteps.clear();
    primitiveCounts.click = 0;
    const unknownWorkflow = await replay.runtime.createWorkflow({
      name: 'Unknown Electron',
      objective: 'Click Buy now',
      entryPoint: { kind: 'url', url: `${baseUrl}${V6_CONSEQUENTIAL_PATH}` },
      trigger: { kind: 'manual' },
    });
    const unknownOccurrence = await replay.runtime.runWorkflowNow(unknownWorkflow.workflowId);
    await replay.runtime.flush();
    await waitUntil(
      () => replay.chain.approvalEvents.some((event) => event.type === 'approval-required'),
      30000,
      () => 'unknown scenario missing approval-required',
    );
    const unknownPending = lastPendingApproval(replay.chain);
    await replay.chain.workflow.decide({ approvalId: unknownPending.approvalId, decision: 'approve' });
    await waitUntil(
      async () =>
        (await replay.runtime.getCoordinator()?.getOccurrence(unknownOccurrence.occurrenceId))?.state ===
        'execution-state-unknown',
      30000,
      () => `unknown was not mapped (clicks=${primitiveCounts.click})`,
    );
    assert.equal(primitiveCounts.click, 1);
    clickMode = 'pass';
    live.forward = false;
    replay.runtime.dispose();
    replay.chain.dispose();
    live.runtime = undefined;
    live.chain = undefined;

    const afterUnknown = await startLive('electron-unknown');
    await afterUnknown.runtime.flush();
    assert.equal(primitiveCounts.click, 1);
    assert.equal(
      (await afterUnknown.runtime.getCoordinator()?.getOccurrence(unknownOccurrence.occurrenceId))?.state,
      'execution-state-unknown',
    );
    afterUnknown.runtime.dispose();
    afterUnknown.chain.dispose();
    live.runtime = undefined;
    live.chain = undefined;

    // F — trusted preload exposes workflows; website views do not.
    const websiteHasWorkflows = await readFixtureState(
      window,
      V6_BACKGROUND_PATH,
      'typeof window.workflows',
    );
    assert.equal(websiteHasWorkflows, 'undefined');
    const websiteHasIpc = await readFixtureState(
      window,
      V6_BACKGROUND_PATH,
      'typeof window.ipcRenderer',
    );
    assert.equal(websiteHasIpc, 'undefined');
    const preloadPath = process.env.V7_ACCEPTANCE_PRELOAD_PATH;
    if (preloadPath) {
      const shell = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: preloadPath,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      try {
        await shell.loadURL('about:blank');
        const apiType = await shell.webContents.executeJavaScript('typeof window.workflows');
        assert.equal(apiType, 'object');
        const hasGetState = await shell.webContents.executeJavaScript(
          'typeof window.workflows.getState === "function"',
        );
        assert.equal(hasGetState, true);
        const hasInvoke = await shell.webContents.executeJavaScript('typeof window.ipcRenderer');
        assert.equal(hasInvoke, 'undefined');
      } finally {
        if (!shell.isDestroyed()) {
          shell.close();
        }
      }
    }

    console.log('[v7-electron-persistent-workflow] PASS');
  } finally {
    disposeLive(false);
    adapter.dispose();
    if (!window.isDestroyed()) {
      window.close();
    }
    await fixture.close();
    await fs.rm(userData, { recursive: true, force: true }).catch(() => undefined);
  }
}

void run()
  .then(() => {
    app.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[v7-electron-persistent-workflow] FAIL');
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    app.exit(1);
  });
