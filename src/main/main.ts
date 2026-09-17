import { app, BrowserWindow } from 'electron';

import { initializeBrowserRuntime } from './browser-runtime';
import { initializeSecurity } from './security';
import { createMainWindow } from './window';

void app.whenReady().then(() => {
  initializeSecurity();
  const mainWindow = createMainWindow();
  initializeBrowserRuntime(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const window = createMainWindow();
      initializeBrowserRuntime(window);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
