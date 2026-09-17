import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { BROWSER_IPC_CHANNELS } from '../shared/ipc-contract';
import { getBrowserAdapter, getMainBrowserWindow, whenBrowserReady } from './browser-runtime';

let handlersRegistered = false;

function isTrustedAppSender(event: IpcMainInvokeEvent): boolean {
  const mainWindow = getMainBrowserWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (event.sender !== mainWindow.webContents) {
    return false;
  }

  if (event.senderFrame && event.senderFrame !== mainWindow.webContents.mainFrame) {
    return false;
  }

  return true;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedAppSender(event)) {
    console.warn('[ipc] rejected browser-shell request from untrusted sender');
    throw new Error('Unauthorized IPC sender');
  }
}

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
    assertTrustedSender(event);
    await whenBrowserReady();
    return getBrowserAdapter().getBrowserState();
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.createTab, async (event) => {
    assertTrustedSender(event);
    await whenBrowserReady();
    return getBrowserAdapter().createTab({ url: 'about:blank' });
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.closeTab, async (event, tabId: unknown) => {
    assertTrustedSender(event);
    await whenBrowserReady();
    await getBrowserAdapter().closeTab(assertTabId(tabId));
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.activateTab, async (event, tabId: unknown) => {
    assertTrustedSender(event);
    await whenBrowserReady();
    await getBrowserAdapter().activateTab(assertTabId(tabId));
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.navigate, async (event, tabId: unknown, url: unknown) => {
    assertTrustedSender(event);
    await whenBrowserReady();
    await getBrowserAdapter().navigate(assertTabId(tabId), assertUrl(url));
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.back, async (event, tabId: unknown) => {
    assertTrustedSender(event);
    await whenBrowserReady();
    await getBrowserAdapter().back(assertTabId(tabId));
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.forward, async (event, tabId: unknown) => {
    assertTrustedSender(event);
    await whenBrowserReady();
    await getBrowserAdapter().forward(assertTabId(tabId));
  });

  ipcMain.handle(BROWSER_IPC_CHANNELS.reload, async (event, tabId: unknown) => {
    assertTrustedSender(event);
    await whenBrowserReady();
    await getBrowserAdapter().reload(assertTabId(tabId));
  });
}
