import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import { ReadOnlyAgent } from '../ai/read-only-agent';
import { AiSdkGatewayRuntime } from '../ai/providers/ai-sdk-gateway';
import { AI_IPC_CHANNELS } from '../shared/ipc-contract';
import { AI_SIDE_PANEL_WIDTH_PX, type AiAnswerEvent } from '../shared/ai-types';
import { AiRequestController } from './ai-request-controller';
import { getMainBrowserWindow } from './browser-runtime';

let controller: AiRequestController | null = null;
let adapter: ElectronBrowserAdapter | null = null;

export function getAiController(): AiRequestController | null {
  return controller;
}

export function initializeAiRuntime(browserAdapter: ElectronBrowserAdapter): void {
  disposeAiRuntime();
  adapter = browserAdapter;
  const agent = new ReadOnlyAgent({
    observationSource: {
      observePage: (tabId, options) => browserAdapter.observePage(tabId, options),
    },
    modelRuntime: new AiSdkGatewayRuntime(),
    allowScreenshotExport: false,
  });
  controller = new AiRequestController({
    agent,
    emit: emitAiAnswerEvent,
  });
}

export function setAiPanelOpen(open: boolean): void {
  if (!adapter) {
    throw new Error('AI runtime not initialized');
  }
  adapter.setWebsiteRightInset(open ? AI_SIDE_PANEL_WIDTH_PX : 0);
}

export function disposeAiRuntime(): void {
  controller?.dispose();
  controller = null;
  adapter = null;
}

function emitAiAnswerEvent(event: AiAnswerEvent): void {
  const window = getMainBrowserWindow();
  if (!window || window.isDestroyed()) {
    return;
  }
  const webContents = window.webContents;
  if (webContents.isDestroyed()) {
    return;
  }
  webContents.send(AI_IPC_CHANNELS.answerEvent, event);
}
