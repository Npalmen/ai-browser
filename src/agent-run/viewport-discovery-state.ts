import type { BoundInteractionProposal } from '../shared/interaction-types';
import type { PageObservation } from '../shared/observation-types';
import { MAX_VIEWPORT_DISCOVERY_SCROLLS } from '../shared/viewport-discovery-policy';

export const MATERIAL_VIEWPORT_SCROLL_DELTA_PX = 5;

export type ViewportDiscoveryDirection = 'up' | 'down';

/**
 * Run-local viewport discovery coverage tracked only from trusted pre/post scroll
 * observations. Used to gate premature target-not-found answers.
 *
 * Bounded target-not-found acceptance (when discovery scroll budget remains):
 * - Reject while content may remain below and bottom has not been reached.
 * - Reject while content may remain above and top has not been reached.
 * - When context is truncated, reject until both boundaries are reached when
 *   document height is known; otherwise require reaching the document bottom.
 * - Accept once the consecutive viewport scroll budget is exhausted.
 */
export interface ViewportDiscoveryState {
  consecutiveViewportScrolls: number;
  searchedDown: number;
  searchedUp: number;
  reachedTop: boolean;
  reachedBottom: boolean;
  startedNearTop: boolean;
  startedNearBottom: boolean;
  startingPositionMarked: boolean;
  lastDiscoveryDirection: ViewportDiscoveryDirection | undefined;
  viewportProgressGeneration: number;
  targetNotFoundCorrectionGeneration: number | undefined;
}

export function createViewportDiscoveryState(
  initialObservation?: PageObservation,
): ViewportDiscoveryState {
  const state: ViewportDiscoveryState = {
    consecutiveViewportScrolls: 0,
    searchedDown: 0,
    searchedUp: 0,
    reachedTop: false,
    reachedBottom: false,
    startedNearTop: false,
    startedNearBottom: false,
    startingPositionMarked: false,
    lastDiscoveryDirection: undefined,
    viewportProgressGeneration: 0,
    targetNotFoundCorrectionGeneration: undefined,
  };
  if (initialObservation !== undefined) {
    markStartingPosition(state, initialObservation);
    syncBoundaryFlagsFromObservation(state, initialObservation);
  }
  return state;
}

export function markStartingPosition(
  state: ViewportDiscoveryState,
  observation: PageObservation,
): void {
  if (state.startingPositionMarked) {
    return;
  }
  state.startingPositionMarked = true;
  if (isAtOrPastDocumentTop(observation.viewport)) {
    state.startedNearTop = true;
  }
  if (isAtOrPastDocumentBottom(observation.viewport)) {
    state.startedNearBottom = true;
  }
}

export function syncBoundaryFlagsFromObservation(
  state: ViewportDiscoveryState,
  observation: PageObservation,
): void {
  if (isAtOrPastDocumentTop(observation.viewport)) {
    state.reachedTop = true;
  }
  if (isAtOrPastDocumentBottom(observation.viewport)) {
    state.reachedBottom = true;
  }
}

export function updateViewportDiscoveryStateAfterScroll(
  state: ViewportDiscoveryState,
  proposal: BoundInteractionProposal,
  preObservation: PageObservation,
  postObservation: PageObservation,
): void {
  if (proposal.kind !== 'scroll' || proposal.mode !== 'viewport') {
    return;
  }

  const direction = proposal.direction;
  const preScrollY = preObservation.viewport.scrollY;
  const postScrollY = postObservation.viewport.scrollY;
  const materialMove = Math.abs(postScrollY - preScrollY) >= MATERIAL_VIEWPORT_SCROLL_DELTA_PX;

  if (direction === 'down') {
    state.searchedDown += 1;
    state.lastDiscoveryDirection = 'down';
  } else if (direction === 'up') {
    state.searchedUp += 1;
    state.lastDiscoveryDirection = 'up';
  }

  syncBoundaryFlagsFromObservation(state, postObservation);

  if (!materialMove) {
    if (direction === 'down') {
      state.reachedBottom = true;
    } else if (direction === 'up') {
      state.reachedTop = true;
    }
    return;
  }

  state.viewportProgressGeneration += 1;
  state.targetNotFoundCorrectionGeneration = undefined;
}

export function resetConsecutiveViewportScrolls(state: ViewportDiscoveryState): void {
  state.consecutiveViewportScrolls = 0;
}

export function hasMoreContentBelow(observation: PageObservation): boolean {
  const documentHeight = observation.viewport.documentHeight;
  if (documentHeight === undefined) {
    return false;
  }
  return observation.viewport.scrollY + observation.viewport.height < documentHeight;
}

export function hasMoreContentAbove(observation: PageObservation): boolean {
  return observation.viewport.scrollY > 0;
}

export function isAtOrPastDocumentTop(viewport: PageObservation['viewport']): boolean {
  return viewport.scrollY <= 0;
}

export function isAtOrPastDocumentBottom(viewport: PageObservation['viewport']): boolean {
  if (viewport.documentHeight === undefined) {
    return false;
  }
  return viewport.scrollY + viewport.height >= viewport.documentHeight;
}

export function shouldRejectPrematureTargetNotFound(
  observation: PageObservation,
  truncatedContext: boolean,
  state: ViewportDiscoveryState,
): boolean {
  if (state.consecutiveViewportScrolls >= MAX_VIEWPORT_DISCOVERY_SCROLLS) {
    return false;
  }

  const moreBelow = hasMoreContentBelow(observation);
  const moreAbove = hasMoreContentAbove(observation);
  const upwardSweepComplete =
    state.searchedUp > 0 &&
    state.reachedTop &&
    !moreAbove &&
    (state.startedNearBottom || !state.startedNearTop);
  const downwardSweepComplete =
    state.searchedDown > 0 &&
    state.reachedBottom &&
    !moreBelow &&
    (state.startedNearTop || !state.startedNearBottom);
  if (upwardSweepComplete || downwardSweepComplete) {
    return false;
  }

  const uninspectedBelow = moreBelow && !state.reachedBottom;
  const uninspectedAbove = moreAbove && !state.reachedTop;
  if (uninspectedBelow || uninspectedAbove) {
    return true;
  }

  if (truncatedContext) {
    const documentHeightKnown = observation.viewport.documentHeight !== undefined;
    if (documentHeightKnown && (!state.reachedTop || !state.reachedBottom)) {
      return true;
    }
    if (!documentHeightKnown && !isAtOrPastDocumentBottom(observation.viewport)) {
      return true;
    }
  }

  return false;
}

export function isTargetNotFoundCorrectionExhausted(state: ViewportDiscoveryState): boolean {
  return state.targetNotFoundCorrectionGeneration === state.viewportProgressGeneration;
}

export function recordTargetNotFoundCorrection(state: ViewportDiscoveryState): void {
  state.targetNotFoundCorrectionGeneration = state.viewportProgressGeneration;
}
