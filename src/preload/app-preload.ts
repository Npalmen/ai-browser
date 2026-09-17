import { contextBridge, ipcRenderer } from 'electron';

import { BROWSER_IPC_CHANNELS, type BrowserShellApi } from '../shared/ipc-contract';
import type { BrowserState } from '../shared/browser-types';

const browserShell: BrowserShellApi = {
  getBrowserState: () => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.getState),

  createTab: () => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.createTab),

  closeTab: (tabId) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.closeTab, tabId),

  activateTab: (tabId) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.activateTab, tabId),

  navigate: (tabId, url) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.navigate, tabId, url),

  back: (tabId) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.back, tabId),

  forward: (tabId) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.forward, tabId),

  reload: (tabId) => ipcRenderer.invoke(BROWSER_IPC_CHANNELS.reload, tabId),

  onStateChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: BrowserState) => {
      listener(state);
    };

    ipcRenderer.on(BROWSER_IPC_CHANNELS.stateChanged, wrapped);

    return () => {
      ipcRenderer.removeListener(BROWSER_IPC_CHANNELS.stateChanged, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('browserShell', browserShell);
