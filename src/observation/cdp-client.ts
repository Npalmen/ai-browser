import type { WebContents } from 'electron';

import { ObservationError } from '../shared/observation-types';
import type {
  CdpAccessibilityTreeResponse,
  CdpDomSnapshotResponse,
  CdpFrameTreeResponse,
  CdpLayoutMetricsResponse,
} from './cdp-types';

const CDP_PROTOCOL_VERSION = '1.3';

const DOM_SNAPSHOT_CAPTURE_PARAMS = {
  computedStyles: ['display', 'visibility', 'opacity'],
  includePaintOrder: false,
  includeDOMRects: true,
  includeBlendedBackgroundColors: false,
  includeTextColorOpacities: false,
} as const;

type AllowedCdpMethod =
  | 'Accessibility.enable'
  | 'Accessibility.getFullAXTree'
  | 'DOMSnapshot.captureSnapshot'
  | 'Page.getLayoutMetrics'
  | 'Page.getFrameTree';

export class ObservationCdpClient {
  constructor(private readonly webContents: WebContents) {}

  async enableAccessibility(): Promise<void> {
    await this.sendCommand('Accessibility.enable');
  }

  async getAccessibilityTree(): Promise<CdpAccessibilityTreeResponse> {
    return this.sendCommand('Accessibility.getFullAXTree') as Promise<CdpAccessibilityTreeResponse>;
  }

  async captureDomSnapshot(): Promise<CdpDomSnapshotResponse> {
    return this.sendCommand('DOMSnapshot.captureSnapshot', DOM_SNAPSHOT_CAPTURE_PARAMS) as Promise<CdpDomSnapshotResponse>;
  }

  async getLayoutMetrics(): Promise<CdpLayoutMetricsResponse> {
    return this.sendCommand('Page.getLayoutMetrics') as Promise<CdpLayoutMetricsResponse>;
  }

  async getFrameTree(): Promise<CdpFrameTreeResponse> {
    return this.sendCommand('Page.getFrameTree') as Promise<CdpFrameTreeResponse>;
  }

  private async sendCommand(
    method: AllowedCdpMethod,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.webContents.isDestroyed()) {
      throw new ObservationError('CDP_UNAVAILABLE', 'Web contents destroyed during observation');
    }

    if (!this.webContents.debugger.isAttached()) {
      throw new ObservationError('CDP_UNAVAILABLE', 'Debugger is not attached');
    }

    try {
      return await this.webContents.debugger.sendCommand(method, params);
    } catch (error: unknown) {
      throw new ObservationError('CDP_UNAVAILABLE', `CDP command failed: ${method}`, {
        cause: error,
      });
    }
  }
}

export { CDP_PROTOCOL_VERSION };
