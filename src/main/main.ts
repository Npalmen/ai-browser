import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  disposeAiRuntime,
  getAiController,
  getAutonomousTaskController,
  handleAutonomousTaskGenericNavigation,
  handleAutonomousTaskRendererCrash,
  handleAutonomousTaskTabCreated,
  initializeAiRuntime,
  invalidateApprovalTab,
  subscribeAutonomousTaskEvents,
} from './ai-runtime';
import { initializeBrowserRuntime, getMainBrowserWindow } from './browser-runtime';
import { registerBrowserShellIpc } from './ipc';
import {
  getPersistentWorkflowRuntime,
  initializePersistentWorkflowRuntime,
  productionWorkflowStoreDirectory,
} from './persistent-workflow-runtime';
import { initializeSecurity } from './security';
import { createMainWindow } from './window';

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = getMainBrowserWindow();
    if (!window) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });

  void app.whenReady().then(async () => {
    initializeSecurity();
    registerBrowserShellIpc();
    await initializePersistentWorkflowRuntime({
      directory: productionWorkflowStoreDirectory(app.getPath('userData')),
      runtimeSessionId: randomUUID(),
    });
    await startBrowserWindow();

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await startBrowserWindow();
      }
    });
  });

  app.on('before-quit', () => {
    getPersistentWorkflowRuntime()?.beginShutdown();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

async function startBrowserWindow(): Promise<void> {
  const mainWindow = createMainWindow();
  const adapter = await initializeBrowserRuntime(mainWindow, {
    onBeforeDispose: () => {
      getPersistentWorkflowRuntime()?.detachExecutionRuntime();
      disposeAiRuntime();
    },
    onTabCreated: (event) => {
      handleAutonomousTaskTabCreated(event);
    },
    onTabInvalidated: (tabId, reason) => {
      if (reason === 'navigation') {
        handleAutonomousTaskGenericNavigation(tabId);
      } else if (reason === 'renderer-crash') {
        handleAutonomousTaskRendererCrash(tabId);
        getAiController()?.handleRendererCrash(tabId);
      } else if (reason === 'tab-close') {
        getAiController()?.handleTabClosed(tabId);
      }
      invalidateApprovalTab(tabId);
    },
  });
  initializeAiRuntime(adapter);
  const taskController = getAutonomousTaskController();
  if (taskController) {
    getPersistentWorkflowRuntime()?.attachExecutionRuntime(
      {
        browser: {
          createTab: (input) => adapter.createTab(input),
          closeTab: (tabId) => adapter.closeTab(tabId),
        },
        autonomousTasks: taskController,
      },
      subscribeAutonomousTaskEvents,
    );
  }
}
