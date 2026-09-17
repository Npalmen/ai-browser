import type { IpcMainInvokeEvent } from 'electron';

import { getMainBrowserWindow } from './browser-runtime';

export function isExactTrustedAppSender(
  sender: object,
  senderFrame: object | null | undefined,
  mainWebContents: object,
  mainFrame: object | null | undefined,
): boolean {
  return sender === mainWebContents && senderFrame != null && senderFrame === mainFrame;
}

export function isTrustedAppSender(event: IpcMainInvokeEvent): boolean {
  const mainWindow = getMainBrowserWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  return isExactTrustedAppSender(
    event.sender,
    event.senderFrame ?? null,
    mainWindow.webContents,
    mainWindow.webContents.mainFrame,
  );
}

export function assertTrustedAppSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedAppSender(event)) {
    console.warn('[ipc] rejected request from untrusted sender');
    throw new Error('Unauthorized IPC sender');
  }
}
