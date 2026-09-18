import type { WebContents } from 'electron';

import { InteractionError } from '../shared/interaction-errors';
import type {
  CdpAccessibilityTreeResponse,
  CdpDomSnapshotResponse,
  CdpFrameTreeResponse,
} from './cdp-types';
import type { CdpGetBoxModelResponse } from './interaction-cdp-types';
import { CDP_PROTOCOL_VERSION } from './cdp-client';

const DOM_SNAPSHOT_CAPTURE_PARAMS = {
  computedStyles: ['display', 'visibility', 'opacity'],
  includePaintOrder: false,
  includeDOMRects: true,
  includeBlendedBackgroundColors: false,
  includeTextColorOpacities: false,
} as const;

type AllowedInteractionCdpMethod =
  | 'Page.getFrameTree'
  | 'DOM.getBoxModel'
  | 'Accessibility.getFullAXTree'
  | 'DOMSnapshot.captureSnapshot'
  | 'Input.dispatchMouseEvent'
  | 'Input.dispatchKeyEvent'
  | 'Input.insertText';

export interface InteractionMouseEventParams {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'left' | 'middle' | 'right' | 'none';
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}

export interface InteractionKeyEventParams {
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers?: number;
}

export class InteractionCdpClient {
  constructor(private readonly webContents: WebContents) {}

  async getFrameTree(): Promise<CdpFrameTreeResponse> {
    return this.sendCommand('Page.getFrameTree') as Promise<CdpFrameTreeResponse>;
  }

  async getBoxModel(backendNodeId: number): Promise<CdpGetBoxModelResponse> {
    return this.sendCommand('DOM.getBoxModel', { backendNodeId }) as Promise<CdpGetBoxModelResponse>;
  }

  async getAccessibilityTree(): Promise<CdpAccessibilityTreeResponse> {
    return this.sendCommand('Accessibility.getFullAXTree') as Promise<CdpAccessibilityTreeResponse>;
  }

  async captureDomSnapshot(): Promise<CdpDomSnapshotResponse> {
    return this.sendCommand(
      'DOMSnapshot.captureSnapshot',
      DOM_SNAPSHOT_CAPTURE_PARAMS,
    ) as Promise<CdpDomSnapshotResponse>;
  }

  async dispatchMouseEvent(params: InteractionMouseEventParams): Promise<void> {
    await this.sendCommand('Input.dispatchMouseEvent', { ...params });
  }

  async dispatchKeyEvent(params: InteractionKeyEventParams): Promise<void> {
    await this.sendCommand('Input.dispatchKeyEvent', { ...params });
  }

  async insertText(text: string): Promise<void> {
    await this.sendCommand('Input.insertText', { text });
  }

  private async sendCommand(
    method: AllowedInteractionCdpMethod,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.webContents.isDestroyed()) {
      throw new InteractionError('INTERACTION_FAILED', 'Web contents destroyed during interaction');
    }

    if (!this.webContents.debugger.isAttached()) {
      throw new InteractionError('INTERACTION_FAILED', 'Debugger is not attached');
    }

    try {
      return await this.webContents.debugger.sendCommand(method, params);
    } catch (error: unknown) {
      throw new InteractionError('INTERACTION_FAILED', `CDP command failed: ${method}`, {
        cause: error,
      });
    }
  }
}

export { CDP_PROTOCOL_VERSION };
