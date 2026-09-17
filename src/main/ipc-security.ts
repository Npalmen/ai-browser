import type { IpcMainInvokeEvent } from 'electron';

import { getMainBrowserWindow } from './browser-runtime';

export function isTrustedAppSender(event: IpcMainInvokeEvent): boolean {
  const mainWindow = getMainBrowserWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (event.sender !== mainWindow.webContents) {
    return false;
  }

  const mainFrame = mainWindow.webContents.mainFrame;
  if (!event.senderFrame || !mainFrame || event.senderFrame !== mainFrame) {
    return false;
  }

  return true;
}

export function assertTrustedAppSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedAppSender(event)) {
    console.warn('[ipc] rejected request from untrusted sender');
    throw new Error('Unauthorized IPC sender');
  }
}
