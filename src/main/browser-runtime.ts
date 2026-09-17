import type { BrowserWindow } from 'electron';

import { ElectronBrowserAdapter } from '../browser/electron-adapter';

let adapter: ElectronBrowserAdapter | null = null;

export function initializeBrowserRuntime(mainWindow: BrowserWindow): ElectronBrowserAdapter {
  adapter = new ElectronBrowserAdapter(mainWindow);

  mainWindow.on('resize', () => {
    adapter?.layoutActiveView();
  });

  mainWindow.on('closed', () => {
    disposeBrowserRuntime();
  });

  void adapter.createTab({ url: 'https://example.com' });

  return adapter;
}

export function disposeBrowserRuntime(): void {
  adapter?.dispose();
  adapter = null;
}
