import type { TabId } from '../shared/browser-types';
import type {
  DocumentRevision,
  FrameId,
} from '../shared/observation-types';
import type { InteractionScrollDirection } from '../shared/interaction-types';

export interface AdapterTargetRef {
  tabId: TabId;
  frameId: FrameId;
  backendNodeId: number;
  documentRevision: DocumentRevision;
}

export interface AdapterObservedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AdapterClickRequest {
  target: AdapterTargetRef;
  observedBounds?: AdapterObservedBounds;
}

export interface AdapterTypeRequest {
  target: AdapterTargetRef;
  text: string;
  observedBounds?: AdapterObservedBounds;
}

export interface AdapterSelectRequest {
  selectTarget: AdapterTargetRef;
  optionTarget: AdapterTargetRef;
  selectObservedBounds?: AdapterObservedBounds;
  optionObservedBounds?: AdapterObservedBounds;
}

export interface AdapterViewportScrollRequest {
  tabId: TabId;
  documentRevision: DocumentRevision;
  direction: InteractionScrollDirection;
  amountPx: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface AdapterScrollIntoViewRequest {
  target: AdapterTargetRef;
  observedBounds?: AdapterObservedBounds;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
}

export interface AdapterInteractionResult {
  primitive: 'click' | 'type' | 'select' | 'scroll';
}
