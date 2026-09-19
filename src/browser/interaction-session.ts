import { BrowserWindow, type WebContents } from 'electron';

import { InteractionError } from '../shared/interaction-errors';
import type { TabId } from '../shared/browser-types';
import { CDP_PROTOCOL_VERSION, InteractionCdpClient } from '../observation/interaction-cdp-client';

interface InteractionSession {
  webContents: WebContents;
  cdp: InteractionCdpClient;
  attachedByThisSession: boolean;
  invalidated: boolean;
  onDebuggerDetach: () => void;
  onWebContentsDestroyed: () => void;
}

export interface InteractionSessionManagerOptions {
  isObservationInProgress?: (tabId: TabId) => boolean;
}

export class InteractionSessionManager {
  private readonly inFlightTabs = new Set<TabId>();

  constructor(private readonly options: InteractionSessionManagerOptions = {}) {}

  isInteractionInProgress(tabId: TabId): boolean {
    return this.inFlightTabs.has(tabId);
  }

  async withSession<T>(
    tabId: TabId,
    webContents: WebContents,
    action: (cdp: InteractionCdpClient) => Promise<T>,
  ): Promise<T> {
    if (this.inFlightTabs.has(tabId)) {
      throw new InteractionError('INTERACTION_IN_PROGRESS', 'An interaction is already in progress for this tab');
    }

    if (this.options.isObservationInProgress?.(tabId)) {
      throw new InteractionError('INTERACTION_IN_PROGRESS', 'An observation is in progress for this tab');
    }

    this.assertPreflight(webContents);

    this.inFlightTabs.add(tabId);
    let session: InteractionSession | null = null;

    try {
      session = await this.beginSession(webContents);
      if (!webContents.isDestroyed()) {
        BrowserWindow?.fromWebContents?.(webContents)?.focus();
        webContents.focus?.();
      }
      return await action(session.cdp);
    } finally {
      if (session !== null) {
        await this.endSession(session);
      }
      this.inFlightTabs.delete(tabId);
    }
  }

  private assertPreflight(webContents: WebContents): void {
    if (webContents.isDestroyed()) {
      throw new InteractionError('TAB_NOT_FOUND', 'Tab web contents is destroyed');
    }

    if (webContents.isDevToolsOpened()) {
      throw new InteractionError('INTERACTION_FAILED', 'DevTools is open for this tab');
    }

    if (webContents.debugger.isAttached()) {
      throw new InteractionError('INTERACTION_FAILED', 'Debugger is already attached for this tab');
    }
  }

  private async beginSession(webContents: WebContents): Promise<InteractionSession> {
    const session: InteractionSession = {
      webContents,
      cdp: new InteractionCdpClient(webContents),
      attachedByThisSession: false,
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
      session.attachedByThisSession = true;
    } catch (error: unknown) {
      throw new InteractionError('INTERACTION_FAILED', 'Failed to attach debugger', { cause: error });
    }

    webContents.debugger.on('detach', session.onDebuggerDetach);
    webContents.once('destroyed', session.onWebContentsDestroyed);

    return session;
  }

  private async endSession(session: InteractionSession): Promise<void> {
    const { webContents } = session;

    if (!webContents.isDestroyed()) {
      webContents.debugger.removeListener('detach', session.onDebuggerDetach);
      webContents.removeListener('destroyed', session.onWebContentsDestroyed);
    }

    if (
      session.attachedByThisSession &&
      !webContents.isDestroyed() &&
      webContents.debugger.isAttached()
    ) {
      try {
        webContents.debugger.detach();
      } catch {
        // Debugger may already be detached by Electron.
      }
    }
  }
}
