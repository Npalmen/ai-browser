import { app, BrowserWindow } from 'electron';

import { initializeBrowserRuntime } from './browser-runtime';
import { registerBrowserShellIpc } from './ipc';
import { initializeSecurity } from './security';
import { createMainWindow } from './window';

void app.whenReady().then(async () => {
  initializeSecurity();
  registerBrowserShellIpc();

  const mainWindow = createMainWindow();
  await initializeBrowserRuntime(mainWindow);

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const window = createMainWindow();
      await initializeBrowserRuntime(window);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
