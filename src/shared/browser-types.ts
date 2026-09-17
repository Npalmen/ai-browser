export type TabId = string;

export interface BrowserTab {
  id: TabId;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: TabId;
}

export interface PageState {
  tabId: TabId;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
