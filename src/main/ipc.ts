import { ipcMain } from 'electron';

import { routeBrowserIntent } from '../ai-native/browser-intent-router';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import {
  AI_NATIVE_IPC_CHANNELS,
  APPROVAL_IPC_CHANNELS,
  AI_IPC_CHANNELS,
  AUTONOMOUS_TASK_IPC_CHANNELS,
  BROWSER_IPC_CHANNELS,
  WORKFLOW_IPC_CHANNELS,
} from '../shared/ipc-contract';
import {
  parseCancelContextAskRequest,
  parseContextAskRequest,
  parseGenerateWorkflowDraftRequest,
  parseGetActivitySummaryRequest,
  parseRouteIntentRequest,
} from './ai-native-ipc-guards';
import { buildTrustedSearchNavigationUrl } from './browser-search-provider';
import { isAiSafeError, parseAskCurrentPageRequest, parseAskId, parsePanelOpen, parseTabId } from './ai-ipc-guards';
import {
  beforeAutonomousTaskTrustedChromeNavigation,
  cancelAgentRunForTrustedChromeNavigation,
  getAiController,
  getAiNativeActivityController,
  getAiNativeContextController,
  getAiNativeWorkflowDraftController,
  getApprovalWorkflowController,
  getAutonomousTaskController,
  handleAutonomousTaskTabClosed,
  invalidateApprovalTab,
  setAiPanelOpen,
} from './ai-runtime';
import { parseApprovalDecideRequest } from './approval-ipc-guards';
import {
  parseAutonomousTaskIdRequest,
  parseAutonomousTaskReplyRequest,
  parseAutonomousTaskStartRequest,
} from './autonomous-task-ipc-guards';
import { approvalSafeError } from './approval-safe-error';
import { aiSafeError, toAiSafeError } from './ai-safe-error';
import { getBrowserAdapter, getMainBrowserWindow, whenBrowserReady } from './browser-runtime';
import { getPersistentWorkflowRuntime } from './persistent-workflow-runtime';
import { assertTrustedAppSender } from './ipc-security';
import { WorkflowProductController } from './workflow-product-controller';
import {
  parseWorkflowCreateRequest,
  parseWorkflowEditRequest,
  parseWorkflowIdRequest,
  parseWorkflowOccurrenceActionRequest,
  parseWorkflowSetEnabledRequest,
} from './workflow-ipc-guards';
import { workflowProductError } from './workflow-product-safe-error';

let handlersRegistered = false;

function assertTabId(tabId: unknown): string {
  if (typeof tabId !== 'string' || tabId.length === 0) {
    throw new Error('Invalid tab id');
  }
  return tabId;
}

function assertUrl(url: unknown): string {
  if (typeof url !== 'string') {
    throw new Error('Invalid url');
  }
  return url;
}

export function registerBrowserShellIpc(): void {
  if (handlersRegistered) {
    return;
  }

  handlersRegistered = true;

  ipcMain.handle(BROWSER_IPC_CHANNELS.getState, async (event) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    return getBrowserAdapter().getBrowserState();
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.createTab, async (event) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    return getBrowserAdapter().createTab({ url: 'about:blank' });
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.closeTab, async (event, tabId: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const trustedTabId = assertTabId(tabId);
    await handleAutonomousTaskTabClosed(trustedTabId);
    getAiController()?.handleTabClosed(trustedTabId);
    invalidateApprovalTab(trustedTabId);
    await getBrowserAdapter().closeTab(trustedTabId);
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.activateTab, async (event, tabId: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    await getBrowserAdapter().activateTab(assertTabId(tabId));
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.navigate, async (event, tabId: unknown, url: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const trustedTabId = assertTabId(tabId);
    await beforeAutonomousTaskTrustedChromeNavigation(trustedTabId);
    cancelAgentRunForTrustedChromeNavigation(trustedTabId);
    invalidateApprovalTab(trustedTabId);
    await getBrowserAdapter().navigate(trustedTabId, assertUrl(url));
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.search, async (event, tabId: unknown, query: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const trustedTabId = assertTabId(tabId);
    const built = buildTrustedSearchNavigationUrl(query);
    if (!built.ok) {
      throw new Error(built.error.message);
    }
    const browserState = getBrowserAdapter().getBrowserState();
    if (!browserState.tabs.some((tab) => tab.id === trustedTabId)) {
      throw new Error('Invalid tab id');
    }
    await beforeAutonomousTaskTrustedChromeNavigation(trustedTabId);
    cancelAgentRunForTrustedChromeNavigation(trustedTabId);
    invalidateApprovalTab(trustedTabId);
    await getBrowserAdapter().navigate(trustedTabId, built.url);
  });

  ipcMain.handle(AI_NATIVE_IPC_CHANNELS.routeIntent, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const parsed = parseRouteIntentRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    return routeBrowserIntent(parsed.input, getBrowserAdapter().getBrowserState());
  });

  ipcMain.handle(AI_NATIVE_IPC_CHANNELS.askContext, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const parsed = parseContextAskRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const contextController = getAiNativeContextController();
    if (!contextController) {
      return { ok: false, error: aiNativeSafeError('AI_NATIVE_NOT_AVAILABLE') };
    }
    return contextController.startAsk(parsed.input);
  });

  ipcMain.handle(AI_NATIVE_IPC_CHANNELS.cancelContextAsk, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseCancelContextAskRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const contextController = getAiNativeContextController();
    if (!contextController) {
      return { cancelled: false };
    }
    return contextController.cancelContextAsk(parsed.askId);
  });

  ipcMain.handle(AI_NATIVE_IPC_CHANNELS.generateWorkflowDraft, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const parsed = parseGenerateWorkflowDraftRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const draftController = getAiNativeWorkflowDraftController();
    if (!draftController) {
      return { ok: false, error: aiNativeSafeError('AI_NATIVE_NOT_AVAILABLE') };
    }
    return draftController.generate(parsed.input);
  });

  ipcMain.handle(AI_NATIVE_IPC_CHANNELS.getActivitySummary, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseGetActivitySummaryRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    await whenBrowserReady();
    const activityController = getAiNativeActivityController();
    if (!activityController) {
      return { ok: false, error: aiNativeSafeError('AI_NATIVE_NOT_AVAILABLE') };
    }
    return activityController.getSummary();
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.back, async (event, tabId: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const trustedTabId = assertTabId(tabId);
    await beforeAutonomousTaskTrustedChromeNavigation(trustedTabId);
    cancelAgentRunForTrustedChromeNavigation(trustedTabId);
    invalidateApprovalTab(trustedTabId);
    await getBrowserAdapter().back(trustedTabId);
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.forward, async (event, tabId: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const trustedTabId = assertTabId(tabId);
    await beforeAutonomousTaskTrustedChromeNavigation(trustedTabId);
    cancelAgentRunForTrustedChromeNavigation(trustedTabId);
    invalidateApprovalTab(trustedTabId);
    await getBrowserAdapter().forward(trustedTabId);
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.reload, async (event, tabId: unknown) => {
    assertTrustedAppSender(event);
    await whenBrowserReady();
    const trustedTabId = assertTabId(tabId);
    await beforeAutonomousTaskTrustedChromeNavigation(trustedTabId);
    cancelAgentRunForTrustedChromeNavigation(trustedTabId);
    invalidateApprovalTab(trustedTabId);
    await getBrowserAdapter().reload(trustedTabId);
  });

  ipcMain.handle(AI_IPC_CHANNELS.askCurrentPage, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parseAskCurrentPageRequest(input, getBrowserAdapter().getBrowserState());
      if (!parsed.ok) {
        return parsed;
      }
      const controller = getAiController();
      if (!controller) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return controller.startAsk(parsed.tabId, parsed.question, parsed.mode);
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(AI_IPC_CHANNELS.cancelAsk, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parseCancelAskInput(input);
      if (!parsed.ok) {
        return { cancelled: false };
      }
      return getAiController()?.cancelAsk(parsed.tabId, parsed.askId) ?? { cancelled: false };
    } catch {
      return { cancelled: false };
    }
  });

  ipcMain.handle(AI_IPC_CHANNELS.clearConversation, async (event, tabId: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsedTabId = parseTabId(tabId);
      if (isAiSafeError(parsedTabId)) {
        return { ok: false, error: parsedTabId };
      }
      const controller = getAiController();
      if (!controller) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return controller.clearConversation(parsedTabId);
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(AI_IPC_CHANNELS.setPanelOpen, async (event, open: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parsePanelOpen(open);
      if (isAiSafeError(parsed)) {
        return { ok: false, error: parsed };
      }
      setAiPanelOpen(parsed);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(APPROVAL_IPC_CHANNELS.decide, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parseApprovalDecideRequest(input);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }
      const workflow = getApprovalWorkflowController();
      if (!workflow) {
        return { ok: false, error: approvalSafeError('APPROVAL_FAILED') };
      }
      return workflow.decide(parsed.input);
    } catch {
      return { ok: false, error: approvalSafeError('APPROVAL_FAILED') };
    }
  });

  ipcMain.handle(AUTONOMOUS_TASK_IPC_CHANNELS.start, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parseAutonomousTaskStartRequest(input);
      if (!parsed.ok) {
        return parsed;
      }
      const runtime = getPersistentWorkflowRuntime();
      if (runtime) {
        return runtime.startManualAutonomousTask(parsed.input.objective);
      }
      const taskController = getAutonomousTaskController();
      if (!taskController) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return taskController.start(parsed.input.objective);
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(AUTONOMOUS_TASK_IPC_CHANNELS.pause, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parseAutonomousTaskIdRequest(input);
      if (!parsed.ok) {
        return parsed;
      }
      const runtime = getPersistentWorkflowRuntime();
      if (runtime) {
        return await runtime.pauseAutonomousTask(parsed.input.taskId);
      }
      const taskController = getAutonomousTaskController();
      if (!taskController) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return await taskController.pause(parsed.input.taskId);
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(AUTONOMOUS_TASK_IPC_CHANNELS.resume, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parseAutonomousTaskIdRequest(input);
      if (!parsed.ok) {
        return parsed;
      }
      const runtime = getPersistentWorkflowRuntime();
      if (runtime) {
        return runtime.resumeManualAutonomousTask(parsed.input.taskId);
      }
      const taskController = getAutonomousTaskController();
      if (!taskController) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return taskController.resume(parsed.input.taskId);
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(AUTONOMOUS_TASK_IPC_CHANNELS.stop, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parseAutonomousTaskIdRequest(input);
      if (!parsed.ok) {
        return parsed;
      }
      const runtime = getPersistentWorkflowRuntime();
      if (runtime) {
        return await runtime.stopAutonomousTask(parsed.input.taskId);
      }
      const taskController = getAutonomousTaskController();
      if (!taskController) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return await taskController.stop(parsed.input.taskId);
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(AUTONOMOUS_TASK_IPC_CHANNELS.reply, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const parsed = parseAutonomousTaskReplyRequest(input);
      if (!parsed.ok) {
        return parsed;
      }
      const taskController = getAutonomousTaskController();
      if (!taskController) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return taskController.reply(parsed.input.taskId, parsed.input.reply);
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(AUTONOMOUS_TASK_IPC_CHANNELS.getState, async (event) => {
    assertTrustedAppSender(event);
    try {
      await whenBrowserReady();
      const taskController = getAutonomousTaskController();
      if (!taskController) {
        return { ok: true, tasks: [] };
      }
      return { ok: true, tasks: taskController.getState() };
    } catch (error) {
      return { ok: false, error: toAiSafeError(error) };
    }
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.getState, async (event) => {
    assertTrustedAppSender(event);
    const controller = workflowProductController();
    if (!controller) {
      return { ok: true, status: 'not-initialized', workflows: [] };
    }
    return controller.getState();
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.getDetail, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowIdRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.getDetail(parsed.input.workflowId);
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.create, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowCreateRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.create(parsed.input);
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.edit, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowEditRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.edit(parsed.input);
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.setEnabled, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowSetEnabledRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.setEnabled(parsed.input.workflowId, parsed.input.enabled);
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.runNow, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowIdRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.runNow(parsed.input.workflowId);
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.acknowledgeReview, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowIdRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.acknowledgeReview(parsed.input.workflowId);
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.stop, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowIdRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.stop(parsed.input.workflowId);
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.cancelQueued, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowOccurrenceActionRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.cancelQueued(parsed.input.workflowId, parsed.input.occurrenceId);
  });

  ipcMain.handle(WORKFLOW_IPC_CHANNELS.delete, async (event, input: unknown) => {
    assertTrustedAppSender(event);
    const parsed = parseWorkflowIdRequest(input);
    if (!parsed.ok) {
      return parsed;
    }
    const controller = workflowProductController();
    if (!controller) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    return controller.delete(parsed.input.workflowId);
  });
}

export function bindWorkflowProductNotifications(): void {
  const runtime = getPersistentWorkflowRuntime();
  runtime?.subscribeStateChanged(() => {
    sendWorkflowStateChanged();
  });
}

function workflowProductController(): WorkflowProductController | undefined {
  const runtime = getPersistentWorkflowRuntime();
  if (!runtime) {
    return undefined;
  }
  return new WorkflowProductController(runtime);
}

function sendWorkflowStateChanged(): void {
  const window = getMainBrowserWindow();
  if (!window || window.isDestroyed()) {
    return;
  }
  const webContents = window.webContents;
  if (webContents.isDestroyed()) {
    return;
  }
  webContents.send(WORKFLOW_IPC_CHANNELS.stateChanged, { type: 'workflow-state-changed' });
}

function parseCancelAskInput(input: unknown):
  | { ok: true; tabId: string; askId: string }
  | { ok: false } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false };
  }
  const record = input as Record<string, unknown>;
  const tabId = parseTabId(record.tabId);
  const askId = parseAskId(record.askId);
  if (isAiSafeError(tabId) || isAiSafeError(askId)) {
    return { ok: false };
  }
  return { ok: true, tabId, askId };
}
