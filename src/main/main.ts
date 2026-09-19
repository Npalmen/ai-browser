import { app, BrowserWindow } from 'electron';

import {
  disposeAiRuntime,
  getAiController,
  handleAutonomousTaskGenericNavigation,
  handleAutonomousTaskRendererCrash,
  handleAutonomousTaskTabCreated,
  initializeAiRuntime,
  invalidateApprovalTab,
} from './ai-runtime';
import { initializeBrowserRuntime } from './browser-runtime';
import { registerBrowserShellIpc } from './ipc';
import { initializeSecurity } from './security';
import { createMainWindow } from './window';

async function startBrowserWindow(): Promise<void> {
  const mainWindow = createMainWindow();
  const adapter = await initializeBrowserRuntime(mainWindow, {
    onBeforeDispose: () => {
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
}

void app.whenReady().then(async () => {
  initializeSecurity();
  registerBrowserShellIpc();

  await startBrowserWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await startBrowserWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
