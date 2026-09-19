import { ipcMain } from 'electron';

import {
  APPROVAL_IPC_CHANNELS,
  AI_IPC_CHANNELS,
  AUTONOMOUS_TASK_IPC_CHANNELS,
  BROWSER_IPC_CHANNELS,
} from '../shared/ipc-contract';
import { isAiSafeError, parseAskCurrentPageRequest, parseAskId, parsePanelOpen, parseTabId } from './ai-ipc-guards';
import {
  beforeAutonomousTaskTrustedChromeNavigation,
  cancelAgentRunForTrustedChromeNavigation,
  getAiController,
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
import { getBrowserAdapter, whenBrowserReady } from './browser-runtime';
import { assertTrustedAppSender } from './ipc-security';

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
