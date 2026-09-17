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
