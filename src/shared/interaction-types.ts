import type { PageState, TabId } from './browser-types';
import type { InteractionErrorCode } from './interaction-errors';
import type {
  DocumentRevision,
  ObservationId,
  PageObservation,
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

/** Authority granted after an explicit allow policy decision. */
export type InteractionAuthority = 'INTERACT' | 'NAVIGATE';

export type InteractionPolicyOutcome =
  | 'ALLOW_INTERACT'
  | 'ALLOW_NAVIGATE'
  | 'DENY'
  | 'DEFER_EXECUTE';

export type InteractionPolicyAllowDecision =
  | { outcome: 'ALLOW_INTERACT'; authority: 'INTERACT' }
  | { outcome: 'ALLOW_NAVIGATE'; authority: 'NAVIGATE' };

export type InteractionPolicyDenyDecision =
  | { outcome: 'DENY'; errorCode: InteractionErrorCode }
  | { outcome: 'DEFER_EXECUTE'; errorCode: 'DEFERRED_TO_EXECUTE' };

export type InteractionPolicyDecision = InteractionPolicyAllowDecision | InteractionPolicyDenyDecision;

export interface InteractionGrant {
  readonly actionId: string;
  readonly authority: InteractionAuthority;
  readonly kind: BoundInteractionProposal['kind'];
  readonly tabId: TabId;
  readonly observationId: ObservationId;
  readonly documentRevision: DocumentRevision;
  readonly targetId?: TargetId;
  readonly optionTargetId?: TargetId;
  readonly issuedAt: number;
}

export interface InteractionResult {
  actionId: string;
  status: 'succeeded' | 'failed' | 'denied';
  pageState: PageState;
  observation?: PageObservation;
  errorCode?: InteractionErrorCode;
}
