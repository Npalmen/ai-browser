import type { TabId } from './browser-types';

export type ObservationId = string;
export type TargetId = string;
export type DocumentRevision = string;
export type FrameId = string;

export interface ObservePageOptions {
  includeScreenshot?: boolean;
}

export interface ObservationScreenshot {
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  encoding: 'base64';
  data: string;
}

export interface NativeSelectOption {
  targetId: TargetId;
  name: string;
  selected?: true;
}

export interface ObservationNode {
  targetId?: TargetId;
  frameId: FrameId;

  role: string;
  name?: string;
  value?: string;
  text?: string;
  tag?: string;

  interactive: boolean;
  visible: boolean;
  inViewport: boolean;

  states?: {
    disabled?: boolean;
    focused?: boolean;
    checked?: boolean | 'mixed';
    selected?: boolean;
    expanded?: boolean;
    editable?: boolean;
    secret?: boolean;
  };

  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  attributes?: Record<string, string>;
  nativeOptions?: ReadonlyArray<NativeSelectOption>;
}

export interface PageObservation {
  observationId: ObservationId;
  tabId: TabId;
  capturedAt: number;

  document: {
    revision: DocumentRevision;
    url: string;
    title: string;
    loading: boolean;
    mainFrameId: FrameId;
  };

  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    deviceScaleFactor: number;
    documentHeight?: number;
  };

  nodes: ObservationNode[];

  screenshot?: ObservationScreenshot;

  stats: {
    sourceAxNodeCount: number;
    sourceDomNodeCount: number;
    emittedNodeCount: number;
    truncated: boolean;
    redactedValueCount: number;
    frameCount: number;
    crossOriginFrameCount: number;
  };
}

export type ObservationErrorCode =
  | 'TAB_NOT_FOUND'
  | 'PAGE_NOT_READY'
  | 'CDP_UNAVAILABLE'
  | 'PAGE_CHANGED_DURING_OBSERVATION'
  | 'OBSERVATION_IN_PROGRESS'
  | 'OBSERVATION_FAILED';

export class ObservationError extends Error {
  readonly code: ObservationErrorCode;

  constructor(code: ObservationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ObservationError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
