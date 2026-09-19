import type { BrowserWindow } from 'electron';

import type { TabId } from '../shared/browser-types';
import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import { BROWSER_IPC_CHANNELS } from '../shared/ipc-contract';
import type { TabInvalidationReason } from '../browser/tab-invalidation';
import type { BrowserTabCreatedEvent } from '../browser/tab-creation';

let adapter: ElectronBrowserAdapter | null = null;
let mainWindow: BrowserWindow | null = null;
let readiness: Promise<void> | null = null;

export function getMainBrowserWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getBrowserAdapter(): ElectronBrowserAdapter {
  if (!adapter) {
    throw new Error('Browser runtime not initialized');
  }
  return adapter;
}

export async function whenBrowserReady(): Promise<void> {
  if (!readiness) {
    throw new Error('Browser runtime not initialized');
  }
  await readiness;
}

export function publishBrowserState(): void {
  const window = getMainBrowserWindow();
  if (!window || window.isDestroyed()) {
    return;
  }

  const webContents = window.webContents;
  if (webContents.isDestroyed() || !adapter) {
    return;
  }

  try {
    const state = adapter.getBrowserState();
    webContents.send(BROWSER_IPC_CHANNELS.stateChanged, state);
  } catch {
    // Skip publishing transient invalid states (for example during final-tab replacement).
  }
}

export async function initializeBrowserRuntime(
  window: BrowserWindow,
  options?: {
    onBeforeDispose?: () => void;
    onTabInvalidated?: (tabId: TabId, reason: TabInvalidationReason) => void;
    onTabCreated?: (event: BrowserTabCreatedEvent) => void;
    initialUrl?: string;
  },
): Promise<ElectronBrowserAdapter> {
  mainWindow = window;
  adapter = new ElectronBrowserAdapter(window, {
    onStateChange: () => {
      publishBrowserState();
    },
    onTabInvalidated: options?.onTabInvalidated,
    onTabCreated: options?.onTabCreated,
  });

  window.on('resize', () => {
    adapter?.layoutActiveView();
  });

  window.on('closed', () => {
    options?.onBeforeDispose?.();
    disposeBrowserRuntime();
  });

  readiness = adapter
    .createTab({ url: options?.initialUrl ?? 'https://example.com' })
    .then(() => {
      publishBrowserState();
    });

  await readiness;

  return adapter;
}

export function disposeBrowserRuntime(): void {
  adapter?.dispose();
  adapter = null;
  mainWindow = null;
  readiness = null;
}
