import { BrowserWindow, session, WebContentsView, type WebContents } from 'electron';

import {
  AgentInputDispatchScope,
  bindClickDispatchScope,
} from './agent-input-dispatch-scope';
import type { BrowserAdapter } from './browser-adapter';
import type {
  AdapterClickRequest,
  AdapterInteractionResult,
  AdapterScrollIntoViewRequest,
  AdapterSelectRequest,
  AdapterTypeRequest,
  AdapterViewportScrollRequest,
} from './interaction-adapter-types';
import {
  executeAdapterClick,
  executeAdapterScrollIntoView,
  executeAdapterSelect,
  executeAdapterType,
  executeAdapterViewportScroll,
} from './interaction-primitives';
import { InteractionSessionManager } from './interaction-session';
import { TabNotFoundError, TabRegistry } from './tab-registry';
import { isMainFrameNavigationInvalidation, type TabInvalidationReason } from './tab-invalidation';
import {
  explicitTabCreatedEvent,
  shouldActivateConvertedPopup,
  websitePopupCreatedEvent,
  type BrowserTabCreatedEvent,
  type CreateTabInput,
} from './tab-creation';
import { ElectronPageObserver } from '../observation/electron-page-observer';
import { TargetRegistry } from '../observation/target-registry';
import type { BrowserState, PageState, TabId } from '../shared/browser-types';
import {
  ObservationError,
  type ObservePageOptions,
  type PageObservation,
} from '../shared/observation-types';
import {
  isAllowedWebsiteNavigation,
  normalizeNavigationUrl,
} from '../shared/navigation-url';
import { getWebsiteViewBounds } from '../main/window';
import { WEBSITE_PARTITION } from '../main/sessions';
import { normalizeRightInset } from '../main/website-view-bounds';

export interface ElectronBrowserAdapterOptions {
  onStateChange?: (state: BrowserState) => void;
  onTabInvalidated?: (tabId: TabId, reason: TabInvalidationReason) => void;
  /** Trusted-main lifecycle only. Not renderer IPC. */
  onTabCreated?: (event: BrowserTabCreatedEvent) => void;
}

export class ElectronBrowserAdapter implements BrowserAdapter {
  private readonly registry = new TabRegistry();
  private readonly views = new Map<TabId, WebContentsView>();
  private readonly targetRegistry = new TargetRegistry();
  private readonly pageObserver = new ElectronPageObserver({
    resolveWebContents: (tabId) => this.resolveWebContents(tabId),
    targetRegistry: this.targetRegistry,
  });
  private readonly interactionSessions = new InteractionSessionManager({
    isObservationInProgress: (tabId) => this.pageObserver.isObservationInProgress(tabId),
  });
  private readonly websiteSession = session.fromPartition(WEBSITE_PARTITION);
  private activeAttachedTabId: TabId | null = null;
  private websiteRightInsetPx = 0;
  private disposed = false;
  private readonly dispatchScope = new AgentInputDispatchScope();

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly options: ElectronBrowserAdapterOptions = {},
  ) {}

  /** Main-process composition only: shared target registry for observation and interaction. */
  getInteractionTargetRegistry(): TargetRegistry {
    return this.targetRegistry;
  }

  async createTab(input?: CreateTabInput): Promise<TabId> {
    return this.createTabInternal({
      url: input?.url,
      activate: input?.activate,
      cause: 'explicit',
      causedByAgentInputDispatch: false,
    });
  }

  async closeTab(tabId: TabId): Promise<void> {
    this.assertNotDisposed();

    if (!this.views.has(tabId)) {
      throw new TabNotFoundError(tabId);
    }

    this.options.onTabInvalidated?.(tabId, 'tab-close');

    if (this.activeAttachedTabId === tabId) {
      this.detachActiveView();
    }

    this.targetRegistry.clearTab(tabId);

    const view = this.views.get(tabId)!;
    this.views.delete(tabId);

    const webContents = view.webContents;
    if (!webContents.isDestroyed()) {
      webContents.close();
    }

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

  async observePage(tabId: TabId, options?: ObservePageOptions): Promise<PageObservation> {
    this.assertNotDisposed();
    return this.pageObserver.observePage(tabId, options);
  }

  async click(request: AdapterClickRequest): Promise<AdapterInteractionResult> {
    this.assertNotDisposed();
    const bound = bindClickDispatchScope(this.dispatchScope, request.target.tabId, request);
    try {
      return await this.interactionSessions.withSession(
        request.target.tabId,
        this.getWebContents(request.target.tabId),
        (cdp) => executeAdapterClick(cdp, bound.request),
      );
    } finally {
      bound.finish();
    }
  }

  async type(request: AdapterTypeRequest): Promise<AdapterInteractionResult> {
    this.assertNotDisposed();
    return this.interactionSessions.withSession(request.target.tabId, this.getWebContents(request.target.tabId), (cdp) =>
      executeAdapterType(cdp, request),
    );
  }

  async select(request: AdapterSelectRequest): Promise<AdapterInteractionResult> {
    this.assertNotDisposed();
    return this.interactionSessions.withSession(
      request.selectTarget.tabId,
      this.getWebContents(request.selectTarget.tabId),
      (cdp) => executeAdapterSelect(cdp, request),
    );
  }

  async scroll(request: AdapterViewportScrollRequest): Promise<AdapterInteractionResult> {
    this.assertNotDisposed();
    return this.interactionSessions.withSession(request.tabId, this.getWebContents(request.tabId), (cdp) =>
      executeAdapterViewportScroll(cdp, request),
    );
  }

  async scrollIntoView(request: AdapterScrollIntoViewRequest): Promise<AdapterInteractionResult> {
    this.assertNotDisposed();
    return this.interactionSessions.withSession(request.target.tabId, this.getWebContents(request.target.tabId), (cdp) =>
      executeAdapterScrollIntoView(cdp, request),
    );
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
    if (this.disposed || !this.activeAttachedTabId) {
      return;
    }

    const view = this.views.get(this.activeAttachedTabId);
    if (!view) {
      return;
    }

    view.setBounds(getWebsiteViewBounds(this.mainWindow, this.websiteRightInsetPx));
  }

  setWebsiteRightInset(rightInsetPx: number): void {
    this.assertNotDisposed();
    this.websiteRightInsetPx = normalizeRightInset(rightInsetPx);
    this.layoutActiveView();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.pageObserver.dispose();
    this.targetRegistry.clearAll();
    this.detachActiveView();

    for (const [tabId, view] of [...this.views.entries()]) {
      const webContents = view.webContents;
      if (!webContents.isDestroyed()) {
        webContents.close();
      }
      this.views.delete(tabId);
    }

    this.registry.clear();
  }

  private attachView(tabId: TabId): void {
    const view = this.getView(tabId);
    const bounds = getWebsiteViewBounds(this.mainWindow, this.websiteRightInsetPx);

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

  private createWebsiteView(): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        session: this.websiteSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
  }

  private recoverFromRendererCrash(tabId: TabId): void {
    if (this.disposed || !this.views.has(tabId)) {
      return;
    }

    this.options.onTabInvalidated?.(tabId, 'renderer-crash');
    console.error(`[adapter] recovering crashed renderer for tab ${tabId}`);

    this.targetRegistry.clearTab(tabId);

    const wasActive = this.activeAttachedTabId === tabId;
    const oldView = this.views.get(tabId)!;

    if (wasActive) {
      this.detachActiveView();
    } else {
      try {
        this.mainWindow.contentView.removeChildView(oldView);
      } catch {
        // View may already be detached.
      }
    }

    if (!oldView.webContents.isDestroyed()) {
      oldView.webContents.close();
    }
    this.views.delete(tabId);

    const replacementView = this.createWebsiteView();
    this.views.set(tabId, replacementView);
    this.registry.updateTab(tabId, {
      url: 'about:blank',
      title: 'Page crashed',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });

    this.attachWebContentsHandlers(tabId, replacementView);

    if (wasActive) {
      this.attachView(tabId);
    }

    void replacementView.webContents.loadURL('about:blank').catch((error: unknown) => {
      console.error(`[adapter] failed to load crash recovery page for tab ${tabId}:`, error);
      if (!this.disposed && this.views.has(tabId)) {
        this.syncMetadata(tabId, true);
      }
    });

    this.publishState();
  }

  private attachWebContentsHandlers(tabId: TabId, view: WebContentsView): void {
    const webContents = view.webContents;

    const denyNavigation = (event: Electron.Event, url: string): void => {
      if (this.disposed || !this.views.has(tabId)) {
        return;
      }

      if (!isAllowedWebsiteNavigation(url)) {
        console.log(`[adapter] denied website navigation: ${url}`);
        event.preventDefault();
      }
    };

    webContents.on('will-navigate', denyNavigation);
    webContents.on('will-redirect', denyNavigation);

    webContents.setWindowOpenHandler(({ url }) => {
      if (this.disposed) {
        return { action: 'deny' };
      }

      const causedByAgentInputDispatch = this.dispatchScope.isActive(tabId);
      let activeTabId: TabId | undefined;
      try {
        activeTabId = this.registry.getActiveTabId();
      } catch {
        activeTabId = undefined;
      }
      const activate = shouldActivateConvertedPopup(tabId, activeTabId);

      if (isAllowedWebsiteNavigation(url)) {
        void this.createTabInternal({
          url,
          activate,
          cause: 'website-popup',
          sourceTabId: tabId,
          causedByAgentInputDispatch,
        }).catch((error: unknown) => {
          console.error('[adapter] failed to open popup as tab:', error);
        });
        return { action: 'deny' };
      }

      console.log(`[adapter] denied website popup: ${url}`);
      return { action: 'deny' };
    });

    webContents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') {
        return;
      }

      this.recoverFromRendererCrash(tabId);
    });

    const sync = (): void => {
      if (this.disposed || !this.views.has(tabId)) {
        return;
      }

      this.syncMetadata(tabId, true);
    };

    webContents.on(
      'did-start-navigation',
      (event: { isMainFrame?: boolean }, _url?: string, _isInPlace?: boolean, isMainFrame?: boolean) => {
        const mainFrame =
          typeof isMainFrame === 'boolean' ? isMainFrame : event?.isMainFrame;
        if (isMainFrameNavigationInvalidation({ isMainFrame: mainFrame })) {
          this.options.onTabInvalidated?.(tabId, 'navigation');
        }
        sync();
      },
    );
    webContents.on('did-navigate', () => {
      if (!this.disposed && this.views.has(tabId)) {
        this.targetRegistry.clearTab(tabId);
      }
      sync();
    });
    webContents.on('did-navigate-in-page', sync);
    webContents.on('did-finish-load', sync);
    webContents.on('page-title-updated', sync);
    webContents.on('did-start-loading', sync);
    webContents.on('did-stop-loading', sync);
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (this.disposed || !this.views.has(tabId)) {
        return;
      }

      console.error(
        `[adapter] page load failed (${errorCode}) ${validatedURL}: ${errorDescription}`,
      );
      this.registry.updateTab(tabId, { loading: false });
      this.syncMetadata(tabId, true);
    });
  }

  private publishState(): void {
    if (this.disposed || !this.options.onStateChange) {
      return;
    }

    try {
      this.options.onStateChange(this.getBrowserState());
    } catch {
      // Skip publishing transient invalid states.
    }
  }

  private syncMetadata(tabId: TabId, publish: boolean): void {
    if (this.disposed) {
      return;
    }

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

  private getWebContents(tabId: TabId): WebContents {
    const view = this.views.get(tabId);
    if (!view) {
      throw new TabNotFoundError(tabId);
    }

    const webContents = view.webContents;
    if (webContents.isDestroyed()) {
      throw new TabNotFoundError(tabId);
    }

    return webContents;
  }

  private resolveWebContents(tabId: TabId): WebContents {
    const view = this.views.get(tabId);
    if (!view) {
      throw new ObservationError('TAB_NOT_FOUND', `Tab not found: ${tabId}`);
    }

    const webContents = view.webContents;
    if (webContents.isDestroyed()) {
      throw new ObservationError('TAB_NOT_FOUND', `Tab web contents destroyed: ${tabId}`);
    }

    return webContents;
  }

  private getView(tabId: TabId): WebContentsView {
    const view = this.views.get(tabId);
    if (!view) {
      throw new TabNotFoundError(tabId);
    }
    return view;
  }

  private async createTabInternal(input: {
    readonly url?: string;
    readonly activate?: boolean;
    readonly cause: 'explicit' | 'website-popup';
    readonly sourceTabId?: TabId;
    readonly causedByAgentInputDispatch: boolean;
  }): Promise<TabId> {
    this.assertNotDisposed();

    const requestedUrl = input.url ?? 'about:blank';
    const normalized = normalizeNavigationUrl(requestedUrl);
    if (!normalized.ok) {
      throw new Error(normalized.reason);
    }

    const tabId = crypto.randomUUID();
    const view = this.createWebsiteView();

    this.views.set(tabId, view);
    this.registry.addTab(
      {
        id: tabId,
        url: normalized.url,
        title: '',
        loading: true,
        canGoBack: false,
        canGoForward: false,
      },
      { activate: input.activate },
    );

    this.attachWebContentsHandlers(tabId, view);
    if (this.registry.getActiveTabId() === tabId) {
      await this.activateTab(tabId);
    }

    this.emitTabCreated(
      input.cause === 'website-popup' && input.sourceTabId !== undefined
        ? websitePopupCreatedEvent({
            tabId,
            sourceTabId: input.sourceTabId,
            causedByAgentInputDispatch: input.causedByAgentInputDispatch,
          })
        : explicitTabCreatedEvent(tabId),
    );

    try {
      await view.webContents.loadURL(normalized.url);
    } catch (error) {
      console.error(`[adapter] failed to load ${normalized.url}:`, error);
      this.syncMetadata(tabId, true);
    }

    this.publishState();
    return tabId;
  }

  private emitTabCreated(event: BrowserTabCreatedEvent): void {
    try {
      this.options.onTabCreated?.(event);
    } catch {
      // Observational lifecycle only. Tab creation already succeeded.
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Browser adapter has been disposed');
    }
  }
}
