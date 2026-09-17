import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

import { CDP_PROTOCOL_VERSION, ObservationCdpClient } from './cdp-client';
import type {
  CdpAccessibilityTreeResponse,
  CdpDomSnapshotResponse,
  CdpFrameTreeResponse,
  CdpLayoutMetricsResponse,
} from './cdp-types';
import { extractDocumentIdentity, type DocumentIdentity } from './document-identity';
import { buildObservation } from './observation-builder';
import { normalizeCollectedSources } from './observation-normalizer';
import { captureObservationScreenshot } from './screenshot';
import type { PageObserver } from './page-observer';
import type { TargetRegistry } from './target-registry';
import {
  ObservationError,
  type ObservePageOptions,
  type ObservationScreenshot,
  type PageObservation,
} from '../shared/observation-types';
import type { TabId } from '../shared/browser-types';

export interface ElectronPageObserverOptions {
  resolveWebContents: (tabId: TabId) => WebContents;
  targetRegistry: TargetRegistry;
}

interface CollectedObservationSources {
  documentIdentity: DocumentIdentity;
  frameTree: CdpFrameTreeResponse;
  layoutMetrics: CdpLayoutMetricsResponse;
  accessibilityTree: CdpAccessibilityTreeResponse;
  domSnapshot: CdpDomSnapshotResponse;
  screenshot?: ObservationScreenshot;
  screenshotTruncated: boolean;
}

interface ObservationSession {
  webContents: WebContents;
  cdp: ObservationCdpClient;
  attachedByThisObservation: boolean;
  invalidated: boolean;
  onDebuggerDetach: () => void;
  onWebContentsDestroyed: () => void;
}

export class ElectronPageObserver implements PageObserver {
  private readonly inFlightTabs = new Set<TabId>();
  private disposed = false;

  constructor(private readonly options: ElectronPageObserverOptions) {}

  dispose(): void {
    this.disposed = true;
  }

  isObservationInProgress(tabId: TabId): boolean {
    return this.inFlightTabs.has(tabId);
  }

  async observePage(tabId: TabId, options?: ObservePageOptions): Promise<PageObservation> {
    const includeScreenshot = options?.includeScreenshot ?? true;

    if (this.disposed) {
      throw new ObservationError('OBSERVATION_FAILED', 'Page observer has been disposed');
    }

    if (this.inFlightTabs.has(tabId)) {
      throw new ObservationError(
        'OBSERVATION_IN_PROGRESS',
        'An observation is already in progress for this tab',
      );
    }

    this.inFlightTabs.add(tabId);
    const observationId = randomUUID();
    const capturedAt = Date.now();

    try {
      const webContents = this.resolveWebContentsForObservation(tabId);
      this.assertPreflight(webContents);

      const session = await this.beginObservationSession(webContents);

      try {
        const sources = await this.collectStructuredSources(
          session,
          webContents,
          includeScreenshot,
        );
        this.assertSessionValid(session, webContents);

        const normalized = normalizeCollectedSources({
          frameTree: sources.frameTree,
          layoutMetrics: sources.layoutMetrics,
          accessibilityTree: sources.accessibilityTree,
          domSnapshot: sources.domSnapshot,
          documentIdentity: sources.documentIdentity,
          pageMetadata: {
            url: webContents.getURL(),
            title: webContents.getTitle(),
            loading: webContents.isLoading(),
          },
        });

        this.assertSessionValid(session, webContents);

        const built = buildObservation({
          observationId,
          tabId,
          capturedAt,
          document: normalized.document,
          viewport: normalized.viewport,
          candidates: normalized.candidates,
          sourceStats: normalized.sourceStats,
          screenshot: sources.screenshot,
          externallyTruncated: sources.screenshotTruncated,
        });

        this.options.targetRegistry.replaceObservation(tabId, observationId, built.targets);
        return built.observation;
      } finally {
        await this.endObservationSession(session);
      }
    } finally {
      this.inFlightTabs.delete(tabId);
    }
  }

  private resolveWebContentsForObservation(tabId: TabId): WebContents {
    try {
      return this.options.resolveWebContents(tabId);
    } catch (error: unknown) {
      if (error instanceof ObservationError) {
        throw error;
      }

      throw new ObservationError('TAB_NOT_FOUND', `Tab not found: ${tabId}`, { cause: error });
    }
  }

  private assertPreflight(webContents: WebContents): void {
    if (this.disposed) {
      throw new ObservationError('OBSERVATION_FAILED', 'Page observer has been disposed');
    }

    if (webContents.isDestroyed()) {
      throw new ObservationError('TAB_NOT_FOUND', 'Tab web contents is destroyed');
    }

    if (webContents.isDevToolsOpened()) {
      throw new ObservationError('CDP_UNAVAILABLE', 'DevTools is open for this tab');
    }

    if (webContents.debugger.isAttached()) {
      throw new ObservationError('CDP_UNAVAILABLE', 'Debugger is already attached for this tab');
    }
  }

  private async beginObservationSession(webContents: WebContents): Promise<ObservationSession> {
    const session: ObservationSession = {
      webContents,
      cdp: new ObservationCdpClient(webContents),
      attachedByThisObservation: false,
      invalidated: false,
      onDebuggerDetach: () => {
        session.invalidated = true;
      },
      onWebContentsDestroyed: () => {
        session.invalidated = true;
      },
    };

    try {
      webContents.debugger.attach(CDP_PROTOCOL_VERSION);
      session.attachedByThisObservation = true;
    } catch (error: unknown) {
      throw new ObservationError('CDP_UNAVAILABLE', 'Failed to attach debugger', { cause: error });
    }

    webContents.debugger.on('detach', session.onDebuggerDetach);
    webContents.once('destroyed', session.onWebContentsDestroyed);

    return session;
  }

  private async endObservationSession(session: ObservationSession): Promise<void> {
    const { webContents } = session;

    if (!webContents.isDestroyed()) {
      webContents.debugger.removeListener('detach', session.onDebuggerDetach);
      webContents.removeListener('destroyed', session.onWebContentsDestroyed);
    }

    if (session.attachedByThisObservation && !webContents.isDestroyed() && webContents.debugger.isAttached()) {
      try {
        webContents.debugger.detach();
      } catch {
        // Debugger may already be detached by Electron.
      }
    }
  }

  private async collectStructuredSources(
    session: ObservationSession,
    expectedWebContents: WebContents,
    includeScreenshot: boolean,
  ): Promise<CollectedObservationSources> {
    this.assertSessionValid(session, expectedWebContents);

    const initialFrameTree = await session.cdp.getFrameTree();
    this.assertSessionValid(session, expectedWebContents);

    const revisionBefore = extractDocumentIdentity(initialFrameTree);

    await session.cdp.enableAccessibility();
    this.assertSessionValid(session, expectedWebContents);

    const layoutMetrics = await session.cdp.getLayoutMetrics();
    this.assertSessionValid(session, expectedWebContents);

    const accessibilityTree = await session.cdp.getAccessibilityTree();
    this.assertSessionValid(session, expectedWebContents);

    const domSnapshot = await session.cdp.captureDomSnapshot();
    this.assertSessionValid(session, expectedWebContents);

    let screenshot: ObservationScreenshot | undefined;
    let screenshotTruncated = false;

    if (includeScreenshot) {
      this.assertSessionValid(session, expectedWebContents);
      const captureResult = await captureObservationScreenshot(expectedWebContents);
      this.assertSessionValid(session, expectedWebContents);
      screenshot = captureResult.screenshot;
      screenshotTruncated = captureResult.screenshotTruncated;
    }

    const finalFrameTree = await session.cdp.getFrameTree();
    this.assertSessionValid(session, expectedWebContents);

    const revisionAfter = extractDocumentIdentity(finalFrameTree);

    if (revisionBefore.revision !== revisionAfter.revision) {
      throw new ObservationError(
        'PAGE_CHANGED_DURING_OBSERVATION',
        'Document changed during observation',
      );
    }

    return {
      documentIdentity: revisionAfter,
      frameTree: finalFrameTree,
      layoutMetrics,
      accessibilityTree,
      domSnapshot,
      screenshot,
      screenshotTruncated,
    };
  }

  private assertSessionValid(session: ObservationSession, expectedWebContents: WebContents): void {
    if (this.disposed) {
      throw new ObservationError('OBSERVATION_FAILED', 'Page observer has been disposed');
    }

    if (session.invalidated) {
      throw new ObservationError('CDP_UNAVAILABLE', 'Debugger session is no longer available');
    }

    if (session.webContents !== expectedWebContents) {
      throw new ObservationError('TAB_NOT_FOUND', 'Tab web contents changed during observation');
    }

    if (session.webContents.isDestroyed()) {
      throw new ObservationError('TAB_NOT_FOUND', 'Tab web contents destroyed during observation');
    }

    if (!session.webContents.debugger.isAttached()) {
      throw new ObservationError('CDP_UNAVAILABLE', 'Debugger is not attached');
    }
  }
}
