import type { PageState, TabId } from '../shared/browser-types';
import type { ObservePageOptions, PageObservation } from '../shared/observation-types';

export interface BrowserAdapter {
  createTab(input?: { url?: string }): Promise<TabId>;
  closeTab(tabId: TabId): Promise<void>;
  activateTab(tabId: TabId): Promise<void>;

  navigate(tabId: TabId, url: string): Promise<void>;
  back(tabId: TabId): Promise<void>;
  forward(tabId: TabId): Promise<void>;
  reload(tabId: TabId): Promise<void>;

  getPageState(tabId: TabId): Promise<PageState>;
  observePage(tabId: TabId, options?: ObservePageOptions): Promise<PageObservation>;
}
