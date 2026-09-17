import type { TabId } from './browser-types';
import type {
  DocumentRevision,
  ObservationId,
  TargetId,
} from './observation-types';

/** ADR-004 §6.3: bounded replace typing for V3 `type`. */
export const MAX_INTERACTION_TYPE_TEXT_LENGTH = 2_000;

/**
 * ADR-004 §6.5: one viewport-equivalent scroll per action.
 * Conservative cap for model proposals without live viewport context at validation time.
 */
export const MAX_INTERACTION_SCROLL_AMOUNT_PX = 1_920;

export const INTERACTION_SCROLL_DIRECTIONS = [
  'up',
  'down',
  'left',
  'right',
] as const;

export type InteractionScrollDirection = (typeof INTERACTION_SCROLL_DIRECTIONS)[number];

export interface ModelClickProposal {
  kind: 'click';
  targetId: TargetId;
}

export interface ModelTypeProposal {
  kind: 'type';
  targetId: TargetId;
  text: string;
}

export interface ModelSelectProposal {
  kind: 'select';
  targetId: TargetId;
  optionTargetId: TargetId;
}

export interface ModelViewportScrollProposal {
  kind: 'scroll';
  mode: 'viewport';
  direction: InteractionScrollDirection;
  amountPx: number;
}

export interface ModelScrollIntoViewProposal {
  kind: 'scroll';
  mode: 'into-view';
  targetId: TargetId;
}

export type ModelScrollProposal = ModelViewportScrollProposal | ModelScrollIntoViewProposal;

export type ModelInteractionProposal =
  | ModelClickProposal
  | ModelTypeProposal
  | ModelSelectProposal
  | ModelScrollProposal;

export interface BoundInteractionIdentity {
  tabId: TabId;
  observationId: ObservationId;
  documentRevision: DocumentRevision;
}

export type BoundClickProposal = ModelClickProposal & BoundInteractionIdentity;
export type BoundTypeProposal = ModelTypeProposal & BoundInteractionIdentity;
export type BoundSelectProposal = ModelSelectProposal & BoundInteractionIdentity;
export type BoundScrollProposal = ModelScrollProposal & BoundInteractionIdentity;

export type BoundInteractionProposal =
  | BoundClickProposal
  | BoundTypeProposal
  | BoundSelectProposal
  | BoundScrollProposal;
