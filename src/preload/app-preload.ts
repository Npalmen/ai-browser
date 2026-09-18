import { contextBridge, ipcRenderer } from 'electron';

import type { AiAnswerEvent, AiAskCurrentPageInput, AiCancelAskInput } from '../shared/ai-types';
import type { ApprovalDecideInput, ApprovalEvent } from '../shared/approval-types';
import type { BrowserState, TabId } from '../shared/browser-types';
import {
  AI_IPC_CHANNELS,
  APPROVAL_IPC_CHANNELS,
  BROWSER_IPC_CHANNELS,
  type AiAssistantApi,
  type BrowserShellApi,
} from '../shared/ipc-contract';

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

const aiAssistant: AiAssistantApi = {
  askCurrentPage: (input: AiAskCurrentPageInput) =>
    ipcRenderer.invoke(AI_IPC_CHANNELS.askCurrentPage, input),

  cancelAsk: (input: AiCancelAskInput) => ipcRenderer.invoke(AI_IPC_CHANNELS.cancelAsk, input),

  clearConversation: (tabId: TabId) => ipcRenderer.invoke(AI_IPC_CHANNELS.clearConversation, tabId),

  setPanelOpen: (open: boolean) => ipcRenderer.invoke(AI_IPC_CHANNELS.setPanelOpen, open),

  onAnswerEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AiAnswerEvent) => {
      listener(payload);
    };

    ipcRenderer.on(AI_IPC_CHANNELS.answerEvent, wrapped);

    return () => {
      ipcRenderer.removeListener(AI_IPC_CHANNELS.answerEvent, wrapped);
    };
  },

  decideApproval: (input: ApprovalDecideInput) =>
    ipcRenderer.invoke(APPROVAL_IPC_CHANNELS.decide, input),

  onApprovalEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ApprovalEvent) => {
      listener(payload);
    };

    ipcRenderer.on(APPROVAL_IPC_CHANNELS.event, wrapped);

    return () => {
      ipcRenderer.removeListener(APPROVAL_IPC_CHANNELS.event, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('browserShell', browserShell);
contextBridge.exposeInMainWorld('aiAssistant', aiAssistant);
