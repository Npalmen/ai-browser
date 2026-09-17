import type { BrowserState, BrowserTab, TabId } from '../shared/browser-types';

export class TabNotFoundError extends Error {
  constructor(tabId: TabId) {
    super(`Tab not found: ${tabId}`);
    this.name = 'TabNotFoundError';
  }
}

export class TabRegistry {
  private tabs: BrowserTab[] = [];
  private activeTabId: TabId | null = null;

  addTab(tab: BrowserTab): void {
    this.tabs.push(tab);
    this.activeTabId = tab.id;
  }

  updateTab(tabId: TabId, patch: Partial<BrowserTab>): void {
    const tab = this.getTab(tabId);
    Object.assign(tab, patch);
  }

  getTab(tabId: TabId): BrowserTab {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      throw new TabNotFoundError(tabId);
    }
    return tab;
  }

  activateTab(tabId: TabId): void {
    this.getTab(tabId);
    this.activeTabId = tabId;
  }

  getActiveTabId(): TabId {
    if (!this.activeTabId) {
      throw new Error('No active tab');
    }
    return this.activeTabId;
  }

  removeTab(tabId: TabId): TabId | null {
    const index = this.tabs.findIndex((entry) => entry.id === tabId);
    if (index === -1) {
      throw new TabNotFoundError(tabId);
    }

    const wasActive = this.activeTabId === tabId;
    this.tabs.splice(index, 1);

    if (this.tabs.length === 0) {
      this.activeTabId = null;
      return null;
    }

    if (!wasActive) {
      return this.activeTabId;
    }

    const nextTab = this.tabs[index] ?? this.tabs[this.tabs.length - 1];
    this.activeTabId = nextTab.id;
    return nextTab.id;
  }

  serialize(): BrowserState {
    if (!this.activeTabId) {
      throw new Error('No active tab');
    }

    return {
      tabs: this.tabs.map((tab) => ({ ...tab })),
      activeTabId: this.activeTabId,
    };
  }

  clear(): void {
    this.tabs = [];
    this.activeTabId = null;
  }
}
