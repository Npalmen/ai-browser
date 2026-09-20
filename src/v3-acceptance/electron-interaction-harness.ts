import assert from 'node:assert/strict';

import { app, BrowserWindow, WebContentsView } from 'electron';

import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import { InteractiveAgent, type InteractiveExecutionResult } from '../ai/interactive-agent';
import { AiRequestController } from '../main/ai-request-controller';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { InteractionExecutor } from '../interaction/interaction-executor';
import type { InteractionResult } from '../shared/interaction-types';
import { startObservationFixtureServer } from '../../scripts/observation-fixture-server';
import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';
import {
  V3_BUY_MUTATED,
  V3_EXPANDED_DETAIL_MARKER,
  V3_DELAYED_NAVIGATION_A_PATH,
  V3_POLICY_DENY_PATH,
  V3_POPUP_SOURCE_PATH,
  V3_POPUP_DESTINATION_MARKER,
  V3_PROMPT_INJECTION_CANARY,
  V3_PROMPT_INJECTION_PATH,
  V3_SAFE_INTERACT_PATH,
  V3_SAME_DOCUMENT_PATH,
  V3_SELECT_EXACT_TARGET_PATH,
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

function requireV3InteractionResult(result: InteractiveExecutionResult): InteractionResult {
  if (result.status === 'approval-required') {
    throw new Error('Expected a V3 interaction result');
  }
  return result;
}

function lastAuditEvent(audit: InMemoryInteractionAuditSink) {
  const events = audit.getEvents();
  assert.ok(events.length > 0);
  return events[events.length - 1];
}

async function run(): Promise<void> {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
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
  window.setAlwaysOnTop(true);
  window.show();
  window.focus();
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
    const click = requireV3InteractionResult(clickResult.result);
    assert.equal(
      click.status,
      'succeeded',
      `click status=${click.status} error=${click.errorCode ?? 'none'}`,
    );
    assert.equal(click.observation !== undefined, true);
    assert.equal(
      observationContainsText(click.observation!.nodes, V3_EXPANDED_DETAIL_MARKER),
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
    const typed = requireV3InteractionResult(typeResult.result);
    assert.equal(
      typed.status,
      'succeeded',
      `type status=${typed.status} error=${typed.errorCode ?? 'none'}`,
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
    const select = requireV3InteractionResult(selectResult.result);
    assert.equal(
      select.status,
      'succeeded',
      `select status=${select.status} error=${select.errorCode ?? 'none'}`,
    );
    const selectObservation = select.observation!;
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
    const scrolled = requireV3InteractionResult(scrollResult.result);
    assert.equal(
      scrolled.status,
      'succeeded',
      `scroll status=${scrolled.status} error=${scrolled.errorCode ?? 'none'}`,
    );
    const scrollAudit = lastAuditEvent(audit);
    assert.equal(scrollAudit.policyOutcome, 'ALLOW_NAVIGATE');
    assert.equal(scrollAudit.grantedAuthority, 'NAVIGATE');
    assert.equal(scrollAudit.adapterPrimitiveInvoked, true);
    assertDebuggerDetached(window);

    await adapter.navigate(tabId, `${baseUrl}${V3_SELECT_EXACT_TARGET_PATH}`);
    await waitForObservation(adapter, tabId);
    audit.clear();
    const registry = adapter.getInteractionTargetRegistry();
    let grantedExact:
      | { optionTargetId: string; backendNodeId?: number }
      | undefined;
    const exactRuntime = new RecordingInteractionModelRuntime((context) => {
      const selectNode = context.nodes.find((node) =>
        node.nativeOptions?.some((option) => option.name === 'Charlie'),
      );
      assert.ok(
        selectNode?.targetId && selectNode.nativeOptions,
        `no exported select with Charlie: ${JSON.stringify(
          context.nodes.map((node) => ({
            name: node.name,
            tag: node.tag,
            options: node.nativeOptions,
          })),
        )}`,
      );
      assert.deepEqual(
        selectNode.nativeOptions.map((option) => option.name),
        ['Alpha', 'Charlie'],
        `model-visible catalog leaked omitted option: ${JSON.stringify(selectNode.nativeOptions)}`,
      );
      const option = selectNode.nativeOptions.find((entry) => entry.name === 'Charlie');
      assert.ok(option, 'Charlie was not exported in nativeOptions');
      const observationId = registry.getCurrentObservationId(tabId);
      const record =
        observationId === null
          ? null
          : registry.resolve(tabId, observationId, option.targetId);
      grantedExact = {
        optionTargetId: option.targetId,
        backendNodeId: record?.backendNodeId,
      };
      return {
        kind: 'interaction',
        proposal: {
          kind: 'select',
          targetId: selectNode.targetId,
          optionTargetId: option.targetId,
        },
      };
    });
    const exactAgent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: exactRuntime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });
    const exactResult = await exactAgent.interact({ tabId, instruction: 'Choose Charlie' });
    assert.equal(exactResult.kind, 'interaction');
    if (exactResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for exact select');
    }
    const exact = requireV3InteractionResult(exactResult.result);
    assert.equal(
      exact.status,
      'succeeded',
      `exact select status=${exact.status} error=${exact.errorCode ?? 'none'}`,
    );
    assert.ok(grantedExact?.backendNodeId, 'granted option backendNodeId was not recorded');
    const exactObservation = exact.observation!;
    const exactSelectNode = exactObservation.nodes.find((node) =>
      node.nativeOptions?.some((option) => option.name === 'Charlie' && option.selected === true),
    );
    assert.ok(exactSelectNode, 'Charlie was not the selected option after execution');
    assert.equal(
      exactSelectNode.nativeOptions?.some((option) => option.name === 'Alpha' && option.selected === true),
      false,
    );
    const selectedCharlie = exactSelectNode.nativeOptions?.find((option) => option.name === 'Charlie');
    const afterRecord =
      selectedCharlie === undefined
        ? null
        : registry.resolve(tabId, exactObservation.observationId, selectedCharlie.targetId);
    assert.equal(afterRecord?.backendNodeId, grantedExact.backendNodeId);
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
    const denied = requireV3InteractionResult(denyResult.result);
    assert.equal(denied.status, 'denied');
    assert.equal(denied.errorCode, 'DEFERRED_TO_EXECUTE');
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
    const sensitive = requireV3InteractionResult(sensitiveResult.result);
    assert.equal(sensitive.status, 'denied');
    assert.equal(sensitive.errorCode, 'TARGET_SENSITIVE');
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

    await adapter.navigate(tabId, `${baseUrl}${V3_DELAYED_NAVIGATION_A_PATH}`);
    await waitForObservation(adapter, tabId);
    audit.clear();
    const delayedRuntime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Open destination').targetId,
      },
    }));
    const delayedAgent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: delayedRuntime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });
    const delayedResult = await delayedAgent.interact({
      tabId,
      instruction: 'Open destination',
    });
    assert.equal(delayedResult.kind, 'interaction');
    if (delayedResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for delayed navigation');
    }
    const delayed = requireV3InteractionResult(delayedResult.result);
    assert.equal(
      delayed.status,
      'succeeded',
      `delayed nav status=${delayed.status} error=${delayed.errorCode ?? 'none'}`,
    );
    assert.equal(delayed.observation?.document.url.includes('delayed-navigation-b.html'), true);
    assert.equal(
      observationContainsText(delayed.observation!.nodes, 'V3_DELAYED_NAV_B_MARKER'),
      true,
    );
    assert.equal(lastAuditEvent(audit).adapterPrimitiveInvoked, true);
    assert.equal(lastAuditEvent(audit).resultStatus, 'succeeded');
    assertDebuggerDetached(window);

    await adapter.navigate(tabId, `${baseUrl}${V3_SAME_DOCUMENT_PATH}`);
    await waitForObservation(adapter, tabId);
    audit.clear();
    const hashRuntime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Jump to section').targetId,
      },
    }));
    const hashAgent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: hashRuntime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });
    const hashResult = await hashAgent.interact({ tabId, instruction: 'Jump to section' });
    assert.equal(hashResult.kind, 'interaction');
    if (hashResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for same-document navigation');
    }
    const hashed = requireV3InteractionResult(hashResult.result);
    assert.equal(
      hashed.status,
      'succeeded',
      `hash nav status=${hashed.status} error=${hashed.errorCode ?? 'none'}`,
    );
    assert.equal(hashed.observation?.document.url.includes('#section'), true);
    assertDebuggerDetached(window);

    await adapter.navigate(tabId, `${baseUrl}${V3_POPUP_SOURCE_PATH}`);
    await waitForObservation(adapter, tabId);
    const tabsBeforePopup = adapter.getBrowserState().tabs.length;
    audit.clear();
    const popupRuntime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Open popup').targetId,
      },
    }));
    const popupAgent = new InteractiveAgent({
      observationSource: {
        observePage: (requestedTabId, options) => adapter.observePage(requestedTabId, options),
      },
      modelRuntime: popupRuntime,
      interactionExecutor: executor,
      allowScreenshotExport: false,
    });
    const popupResult = await popupAgent.interact({ tabId, instruction: 'Open popup' });
    assert.equal(popupResult.kind, 'interaction');
    if (popupResult.kind !== 'interaction') {
      throw new Error('Expected interaction result for popup conversion');
    }
    const popup = requireV3InteractionResult(popupResult.result);
    assert.equal(
      popup.status,
      'succeeded',
      `popup nav status=${popup.status} error=${popup.errorCode ?? 'none'}`,
    );
    assert.equal(
      observationContainsText(popup.observation!.nodes, V3_POPUP_DESTINATION_MARKER),
      true,
    );
    assert.equal(popup.navigation?.kind, 'popup');
    assert.equal(popup.navigation?.sourceTabId, tabId);
    assert.ok(popup.navigation?.destinationTabId);
    assert.notEqual(popup.navigation?.destinationTabId, tabId);
    const sourceAfterPopup = await adapter.observePage(tabId, { includeScreenshot: false });
    assert.equal(
      observationContainsText(sourceAfterPopup.nodes, 'V3_POPUP_SOURCE_MARKER'),
      true,
    );
    await waitUntil(() => adapter.getBrowserState().tabs.length > tabsBeforePopup);
    assert.equal(adapter.getBrowserState().tabs.length, tabsBeforePopup + 1);
    assert.equal(lastAuditEvent(audit).adapterPrimitiveInvoked, true);
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
