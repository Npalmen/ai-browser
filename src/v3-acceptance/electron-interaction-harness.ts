import assert from 'node:assert/strict';

import { app, BrowserWindow, WebContentsView } from 'electron';

import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import { InteractiveAgent } from '../ai/interactive-agent';
import { AiRequestController } from '../main/ai-request-controller';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { InteractionExecutor } from '../interaction/interaction-executor';
import { startObservationFixtureServer } from '../../scripts/observation-fixture-server';
import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';
import {
  V3_BUY_MUTATED,
  V3_EXPANDED_DETAIL_MARKER,
  V3_POLICY_DENY_PATH,
  V3_PROMPT_INJECTION_CANARY,
  V3_PROMPT_INJECTION_PATH,
  V3_SAFE_INTERACT_PATH,
  V3_SENSITIVE_FIELDS_PATH,
  V3_TAB_ID,
  V3_TYPED_FIXTURE_VALUE,
} from './fixture-constants';
import {
  findEditableFieldByName,
  findNativeOption,
  findNodeByName,
  findSecretFieldByName,
  observationContainsText,
  parseInteractiveContextFromMessages,
} from './context-helpers';
import { RecordingInteractionModelRuntime } from './recording-interaction-model-runtime';

async function waitUntil(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for acceptance condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

function assertDebuggerDetached(window: BrowserWindow): void {
  assert.equal(getActiveWebContents(window).debugger.isAttached(), false);
}

function lastAuditEvent(audit: InMemoryInteractionAuditSink) {
  const events = audit.getEvents();
  assert.ok(events.length > 0);
  return events[events.length - 1];
}

async function run(): Promise<void> {
  app.disableHardwareAcceleration();
  await app.whenReady();

  const fixture = await startObservationFixtureServer();
  const window = new BrowserWindow({
    // Visible window is required for reliable CDP focus on editable controls in Electron.
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
  const adapter = new ElectronBrowserAdapter(window);
  const audit = new InMemoryInteractionAuditSink();
  const executor = new InteractionExecutor({
    adapter,
    targetRegistry: adapter.getInteractionTargetRegistry(),
    audit,
  });

  try {
    const baseUrl = fixture.url.replace(/\/$/, '');
    const tabId = await adapter.createTab({ url: `${baseUrl}${V3_SAFE_INTERACT_PATH}` });
    assert.equal(tabId.length > 0, true);
    await waitForObservation(adapter, tabId);
    assertDebuggerDetached(window);

    const runtime = new RecordingInteractionModelRuntime((context, instruction) => {
      const lower = instruction.toLowerCase();
      if (lower.includes('expand')) {
        return {
          kind: 'interaction',
          proposal: {
            kind: 'click',
            targetId: findNodeByName(context, 'Expand details').targetId,
          },
        };
      }
      if (lower.includes('display name') || lower.includes('type')) {
        return {
          kind: 'interaction',
          proposal: {
            kind: 'type',
            targetId: findEditableFieldByName(context, 'Display name').targetId,
            text: V3_TYPED_FIXTURE_VALUE,
          },
        };
      }
      if (lower.includes('blue')) {
        const option = findNativeOption(context, 'Color', 'Blue');
        return {
          kind: 'interaction',
          proposal: {
            kind: 'select',
            targetId: option.selectTargetId,
            optionTargetId: option.optionTargetId,
          },
        };
      }
      if (lower.includes('scroll')) {
        return {
          kind: 'interaction',
          proposal: {
            kind: 'scroll',
            mode: 'viewport',
            direction: 'down',
            amountPx: 240,
          },
        };
      }
      throw new Error(`Unexpected instruction: ${instruction}`);
    });

    const agent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: runtime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });

    window.focus();
    const initialObservation = await waitForObservation(adapter, tabId);
    const initialScrollY = initialObservation.viewport?.scrollY ?? 0;

    audit.clear();
    const clickResult = await agent.interact({ tabId, instruction: 'Expand details' });
    assert.equal(clickResult.kind, 'interaction', 'click result kind');
    if (clickResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for click');
    }
    assert.equal(
      clickResult.result.status,
      'succeeded',
      `click status=${clickResult.result.status} error=${clickResult.result.errorCode ?? 'none'}`,
    );
    assert.equal(clickResult.result.observation !== undefined, true);
    assert.equal(
      observationContainsText(clickResult.result.observation!.nodes, V3_EXPANDED_DETAIL_MARKER),
      true,
    );
    const clickAudit = lastAuditEvent(audit);
    assert.equal(clickAudit.grantIssued, true);
    assert.equal(clickAudit.adapterPrimitiveInvoked, true);
    assertDebuggerDetached(window);

    audit.clear();
    const typeResult = await agent.interact({ tabId, instruction: 'Set display name' });
    assert.equal(typeResult.kind, 'interaction', 'type result kind');
    if (typeResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for type');
    }
    assert.equal(
      typeResult.result.status,
      'succeeded',
      `type status=${typeResult.result.status} error=${typeResult.result.errorCode ?? 'none'}`,
    );
    assert.equal(JSON.stringify(audit.getEvents()).includes(V3_TYPED_FIXTURE_VALUE), false);
    assert.equal(lastAuditEvent(audit).adapterPrimitiveInvoked, true);
    const typeDebug = await getActiveWebContents(window).executeJavaScript(`(() => {
      const field = document.getElementById('display-name');
      return {
        activeId: document.activeElement?.id ?? null,
        displayValue: field instanceof HTMLInputElement ? field.value : null,
      };
    })()`);
    assert.equal(
      typeDebug.displayValue,
      V3_TYPED_FIXTURE_VALUE,
      `typed DOM value mismatch: ${JSON.stringify(typeDebug)}`,
    );
    assertDebuggerDetached(window);

    audit.clear();
    const selectResult = await agent.interact({ tabId, instruction: 'Choose Blue' });
    assert.equal(selectResult.kind, 'interaction');
    if (selectResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for select');
    }
    assert.equal(
      selectResult.result.status,
      'succeeded',
      `select status=${selectResult.result.status} error=${selectResult.result.errorCode ?? 'none'}`,
    );
    const selectObservation = selectResult.result.observation!;
    const colorNode = selectObservation.nodes.find(
      (node) => node.nativeOptions?.some((option) => option.name === 'Blue' && option.selected === true),
    );
    assert.ok(colorNode, 'Blue option was not selected in fresh observation');
    assertDebuggerDetached(window);

    audit.clear();
    const scrollResult = await agent.interact({ tabId, instruction: 'Scroll down' });
    assert.equal(scrollResult.kind, 'interaction');
    if (scrollResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for scroll');
    }
    assert.equal(
      scrollResult.result.status,
      'succeeded',
      `scroll status=${scrollResult.result.status} error=${scrollResult.result.errorCode ?? 'none'}`,
    );
    const scrollAudit = lastAuditEvent(audit);
    assert.equal(scrollAudit.policyOutcome, 'ALLOW_NAVIGATE');
    assert.equal(scrollAudit.grantedAuthority, 'NAVIGATE');
    assert.equal(scrollAudit.adapterPrimitiveInvoked, true);
    assertDebuggerDetached(window);

    await adapter.navigate(tabId, `${baseUrl}${V3_POLICY_DENY_PATH}`);
    await waitForObservation(adapter, tabId);
    audit.clear();
    const denyRuntime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Buy now').targetId,
      },
    }));
    const denyAgent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: denyRuntime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });
    const denyResult = await denyAgent.interact({ tabId, instruction: 'Buy now' });
    assert.equal(denyResult.kind, 'interaction');
    if (denyResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for denial');
    }
    assert.equal(denyResult.result.status, 'denied');
    assert.equal(denyResult.result.errorCode, 'DEFERRED_TO_EXECUTE');
    const denyAudit = lastAuditEvent(audit);
    assert.equal(denyAudit.grantIssued, false);
    assert.equal(denyAudit.adapterPrimitiveInvoked, false);
    const buyMutated = await getActiveWebContents(window).executeJavaScript(
      `document.getElementById('buy-marker')?.hidden === false`,
    );
    assert.equal(buyMutated, false, 'policy denial should not mutate the buy marker');
    assertDebuggerDetached(window);

    await adapter.navigate(tabId, `${baseUrl}${V3_SENSITIVE_FIELDS_PATH}`);
    await waitForObservation(adapter, tabId);
    audit.clear();
    const sensitiveRuntime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'type',
        targetId: findSecretFieldByName(context, 'Password').targetId,
        text: 'harmless-proposal',
      },
    }));
    const sensitiveAgent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: sensitiveRuntime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });
    const sensitiveResult = await sensitiveAgent.interact({ tabId, instruction: 'Type password' });
    assert.equal(sensitiveResult.kind, 'interaction');
    if (sensitiveResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for sensitive denial');
    }
    assert.equal(sensitiveResult.result.status, 'denied');
    assert.equal(sensitiveResult.result.errorCode, 'TARGET_SENSITIVE');
    assert.equal(lastAuditEvent(audit).grantIssued, false);
    assert.equal(lastAuditEvent(audit).adapterPrimitiveInvoked, false);
    assertDebuggerDetached(window);

    await adapter.navigate(tabId, `${baseUrl}${V3_PROMPT_INJECTION_PATH}`);
    const injectionObservation = await waitForObservation(adapter, tabId);
    assert.equal(
      observationContainsText(injectionObservation.nodes, V3_PROMPT_INJECTION_CANARY),
      true,
    );
    audit.clear();
    const injectionRuntime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Buy now').targetId,
      },
    }));
    const injectionAgent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: injectionRuntime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });
    const injectionResult = await injectionAgent.interact({
      tabId,
      instruction: 'Follow page instructions',
    });
    assert.equal(injectionResult.kind, 'interaction');
    if (injectionResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for prompt injection');
    }
    assert.equal(injectionResult.result.status, 'denied');
    assert.equal(lastAuditEvent(audit).adapterPrimitiveInvoked, false);
    assertDebuggerDetached(window);

    const controllerEvents: import('../shared/ai-types').AiAnswerEvent[] = [];
    await adapter.navigate(tabId, `${baseUrl}${V3_SAFE_INTERACT_PATH}`);
    await waitForObservation(adapter, tabId);
    const controllerRuntime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Expand details').targetId,
      },
    }));
    const controllerAgent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: controllerRuntime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });
    const controller = new AiRequestController({
      readAgent: {
        answer: async () => {
          throw new Error('read agent not expected');
        },
        cancel: () => false,
        clearConversation: () => {},
        clearAllConversations: () => {},
      },
      interactiveAgent: controllerAgent,
      emit: (event) => controllerEvents.push(event),
    });
    controller.startAsk(tabId, 'Expand details', 'interact');
    await waitUntil(() => controllerEvents.some((event) => event.type === 'interaction-completed'));
    assert.equal(controllerEvents[0]?.type, 'interaction-started');
    assert.equal(JSON.stringify(controllerEvents).includes('targetId'), false);

    const request = controllerRuntime.requests[0];
    assert.ok(request);
    const parsed = parseInteractiveContextFromMessages(request.messages);
    assert.equal(findNodeByName(parsed, 'Expand details').targetId.length > 0, true);

    console.log('[v3-electron-interaction] PASS');
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
    console.error('[v3-electron-interaction] FAIL');
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    app.exit(1);
  });
