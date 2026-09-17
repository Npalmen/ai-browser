import { BrowserWindow, session, WebContentsView } from 'electron';

import type { BrowserAdapter } from './browser-adapter';
import { TabNotFoundError, TabRegistry } from './tab-registry';
import type { BrowserState, PageState, TabId } from '../shared/browser-types';
import {
  isAllowedWebsiteNavigation,
  normalizeNavigationUrl,
} from '../shared/navigation-url';
import { getWebsiteViewBounds } from '../main/window';
import { WEBSITE_PARTITION } from '../main/sessions';

export interface ElectronBrowserAdapterOptions {
  onStateChange?: (state: BrowserState) => void;
}

export class ElectronBrowserAdapter implements BrowserAdapter {
  private readonly registry = new TabRegistry();
  private readonly views = new Map<TabId, WebContentsView>();
  private readonly websiteSession = session.fromPartition(WEBSITE_PARTITION);
  private activeAttachedTabId: TabId | null = null;
  private disposed = false;

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly options: ElectronBrowserAdapterOptions = {},
  ) {}

  async createTab(input?: { url?: string }): Promise<TabId> {
    this.assertNotDisposed();

    const requestedUrl = input?.url ?? 'about:blank';
    const normalized = normalizeNavigationUrl(requestedUrl);
    if (!normalized.ok) {
      throw new Error(normalized.reason);
    }

    const tabId = crypto.randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        session: this.websiteSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });

    this.views.set(tabId, view);
    this.registry.addTab({
      id: tabId,
      url: normalized.url,
      title: '',
      loading: true,
      canGoBack: false,
      canGoForward: false,
    });

    this.attachWebContentsHandlers(tabId, view);
    await this.activateTab(tabId);

    try {
      await view.webContents.loadURL(normalized.url);
    } catch (error) {
      console.error(`[adapter] failed to load ${normalized.url}:`, error);
      this.syncMetadata(tabId, true);
    }

    this.publishState();
    return tabId;
  }

  async closeTab(tabId: TabId): Promise<void> {
    this.assertNotDisposed();

    if (!this.views.has(tabId)) {
      throw new TabNotFoundError(tabId);
    }

    if (this.activeAttachedTabId === tabId) {
      this.detachActiveView();
    }

    const view = this.views.get(tabId)!;
    const webContents = view.webContents;
    if (!webContents.isDestroyed()) {
      webContents.close();
    }
    this.views.delete(tabId);

    const nextActiveTabId = this.registry.removeTab(tabId);
    if (nextActiveTabId === null) {
      await this.createTab({ url: 'about:blank' });
      return;
    }

    if (this.registry.getActiveTabId() !== this.activeAttachedTabId) {
      await this.activateTab(this.registry.getActiveTabId());
    }

    this.publishState();
  }

  async activateTab(tabId: TabId): Promise<void> {
    this.assertNotDisposed();

    if (!this.views.has(tabId)) {
      throw new TabNotFoundError(tabId);
    }

    if (this.activeAttachedTabId === tabId) {
      this.registry.activateTab(tabId);
      this.publishState();
      return;
    }

    this.detachActiveView();
    this.registry.activateTab(tabId);
    this.attachView(tabId);
    this.publishState();
  }

  async navigate(tabId: TabId, url: string): Promise<void> {
    this.assertNotDisposed();

    const normalized = normalizeNavigationUrl(url);
    if (!normalized.ok) {
      throw new Error(normalized.reason);
    }

    const view = this.getView(tabId);

    try {
      await view.webContents.loadURL(normalized.url);
    } catch (error) {
      console.error(`[adapter] failed to navigate to ${normalized.url}:`, error);
      this.syncMetadata(tabId, true);
    }
  }

  async back(tabId: TabId): Promise<void> {
    this.assertNotDisposed();

    const webContents = this.getView(tabId).webContents;
    if (webContents.navigationHistory.canGoBack()) {
      webContents.navigationHistory.goBack();
    }
  }

  async forward(tabId: TabId): Promise<void> {
    this.assertNotDisposed();

    const webContents = this.getView(tabId).webContents;
    if (webContents.navigationHistory.canGoForward()) {
      webContents.navigationHistory.goForward();
    }
  }

  async reload(tabId: TabId): Promise<void> {
    this.assertNotDisposed();
    this.getView(tabId).webContents.reload();
  }

  getBrowserState(): BrowserState {
    this.assertNotDisposed();

    for (const tabId of this.views.keys()) {
      this.syncMetadata(tabId, false);
    }

    return this.registry.serialize();
  }

  async getPageState(tabId: TabId): Promise<PageState> {
    this.assertNotDisposed();

    if (!this.views.has(tabId)) {
      throw new TabNotFoundError(tabId);
    }

    this.syncMetadata(tabId, false);
    const tab = this.registry.getTab(tabId);
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    };
  }

  layoutActiveView(): void {
    if (!this.activeAttachedTabId) {
      return;
    }

    const view = this.views.get(this.activeAttachedTabId);
    if (!view) {
      return;
    }

    view.setBounds(getWebsiteViewBounds(this.mainWindow));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.detachActiveView();

    for (const [tabId, view] of this.views) {
      const webContents = view.webContents;
      if (!webContents.isDestroyed()) {
        webContents.close();
      }
      this.views.delete(tabId);
    }

    this.registry.clear();
    this.disposed = true;
  }

  private attachView(tabId: TabId): void {
    const view = this.getView(tabId);
    const bounds = getWebsiteViewBounds(this.mainWindow);

    this.mainWindow.contentView.addChildView(view);
    view.setBounds(bounds);
    view.webContents.focus();
    this.activeAttachedTabId = tabId;
  }

  private detachActiveView(): void {
    if (!this.activeAttachedTabId) {
      return;
    }

    const view = this.views.get(this.activeAttachedTabId);
    if (view) {
      try {
        this.mainWindow.contentView.removeChildView(view);
      } catch {
        // View may already be detached.
      }
    }

    this.activeAttachedTabId = null;
  }

  private attachWebContentsHandlers(tabId: TabId, view: WebContentsView): void {
    const webContents = view.webContents;

    const denyNavigation = (event: Electron.Event, url: string): void => {
      if (!isAllowedWebsiteNavigation(url)) {
        console.log(`[adapter] denied website navigation: ${url}`);
        event.preventDefault();
      }
    };

    webContents.on('will-navigate', denyNavigation);
    webContents.on('will-redirect', denyNavigation);

    webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedWebsiteNavigation(url)) {
        void this.createTab({ url }).catch((error: unknown) => {
          console.error('[adapter] failed to open popup as tab:', error);
        });
        return { action: 'deny' };
      }

      console.log(`[adapter] denied website popup: ${url}`);
      return { action: 'deny' };
    });

    const sync = (): void => {
      this.syncMetadata(tabId, true);
    };

    webContents.on('did-start-navigation', sync);
    webContents.on('did-navigate', sync);
    webContents.on('did-navigate-in-page', sync);
    webContents.on('did-finish-load', sync);
    webContents.on('page-title-updated', sync);
    webContents.on('did-start-loading', sync);
    webContents.on('did-stop-loading', sync);
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[adapter] page load failed (${errorCode}) ${validatedURL}: ${errorDescription}`,
      );
      this.registry.updateTab(tabId, { loading: false });
      this.syncMetadata(tabId, true);
    });
  }

  private publishState(): void {
    if (!this.options.onStateChange) {
      return;
    }

    try {
      this.options.onStateChange(this.getBrowserState());
    } catch {
      // Skip publishing transient invalid states.
    }
  }

  private syncMetadata(tabId: TabId, publish: boolean): void {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }

    const webContents = view.webContents;
    if (webContents.isDestroyed()) {
      return;
    }

    const history = webContents.navigationHistory;
    this.registry.updateTab(tabId, {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      loading: webContents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    });

    if (publish) {
      this.publishState();
    }
  }

  private getView(tabId: TabId): WebContentsView {
    const view = this.views.get(tabId);
    if (!view) {
      throw new TabNotFoundError(tabId);
    }
    return view;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Browser adapter has been disposed');
    }
  }
}
