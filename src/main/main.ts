import { app, BrowserWindow } from 'electron';

import { initializeSecurity } from './security';
import { createMainWindow } from './window';

void app.whenReady().then(() => {
  initializeSecurity();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
