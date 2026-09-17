import type {
  AiAnswerEvent,
  AiAskCurrentPageInput,
  AiAskStartResult,
  AiCancelAskInput,
  AiCancelAskResult,
  AiClearConversationResult,
  AiSetPanelOpenResult,
} from './ai-types';
import type { BrowserState, TabId } from './browser-types';

export const BROWSER_IPC_CHANNELS = {
  getState: 'browser:get-state',
  createTab: 'browser:create-tab',
  closeTab: 'browser:close-tab',
  activateTab: 'browser:activate-tab',
  navigate: 'browser:navigate',
  back: 'browser:back',
  forward: 'browser:forward',
  reload: 'browser:reload',
  stateChanged: 'browser:state-changed',
} as const;

export const AI_IPC_CHANNELS = {
  askCurrentPage: 'ai:ask-current-page',
  cancelAsk: 'ai:cancel-ask',
  clearConversation: 'ai:clear-conversation',
  setPanelOpen: 'ai:set-panel-open',
  answerEvent: 'ai:answer-event',
} as const;

export interface BrowserShellApi {
  getBrowserState(): Promise<BrowserState>;

  createTab(): Promise<TabId>;
  closeTab(tabId: TabId): Promise<void>;
  activateTab(tabId: TabId): Promise<void>;

  navigate(tabId: TabId, url: string): Promise<void>;
  back(tabId: TabId): Promise<void>;
  forward(tabId: TabId): Promise<void>;
  reload(tabId: TabId): Promise<void>;

  onStateChanged(listener: (state: BrowserState) => void): () => void;
}

export interface AiAssistantApi {
  askCurrentPage(input: AiAskCurrentPageInput): Promise<AiAskStartResult>;
  cancelAsk(input: AiCancelAskInput): Promise<AiCancelAskResult>;
  clearConversation(tabId: TabId): Promise<AiClearConversationResult>;
  setPanelOpen(open: boolean): Promise<AiSetPanelOpenResult>;
  onAnswerEvent(listener: (event: AiAnswerEvent) => void): () => void;
}
