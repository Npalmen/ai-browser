import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import { InteractiveAgent } from '../ai/interactive-agent';
import { ReadOnlyAgent } from '../ai/read-only-agent';
import { AiSdkGatewayRuntime } from '../ai/providers/ai-sdk-gateway';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { InteractionExecutor } from '../interaction/interaction-executor';
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
  const gatewayRuntime = new AiSdkGatewayRuntime();
  const observationSource = {
    observePage: (tabId: string, options?: Parameters<ElectronBrowserAdapter['observePage']>[1]) =>
      browserAdapter.observePage(tabId, options),
  };
  const readAgent = new ReadOnlyAgent({
    observationSource,
    modelRuntime: gatewayRuntime,
    allowScreenshotExport: false,
  });
  const interactionExecutor = new InteractionExecutor({
    adapter: browserAdapter,
    targetRegistry: browserAdapter.getInteractionTargetRegistry(),
    audit: new InMemoryInteractionAuditSink(),
  });
  const interactiveAgent = new InteractiveAgent({
    observationSource,
    modelRuntime: gatewayRuntime,
    interactionExecutor,
    allowScreenshotExport: false,
  });
  controller = new AiRequestController({
    readAgent,
    interactiveAgent,
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
