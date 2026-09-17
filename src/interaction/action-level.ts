import type { ModelInteractionProposal } from '../shared/interaction-types';

/** Authority levels granted after semantic policy in later phases. */
export type InteractionAuthorityLevel = 'INTERACT' | 'NAVIGATE';

/**
 * Deterministic policy requirement before a grant may be issued.
 * This is not authorization and does not execute anything.
 */
export type InteractionPolicyRequirement =
  | InteractionAuthorityLevel
  | 'SEMANTIC_POLICY';

/**
 * Returns which policy path a proposal must pass. Does not classify semantic effect.
 * `click` has no unconditional authority level.
 */
export function interactionPolicyRequirement(
  proposal: ModelInteractionProposal,
): InteractionPolicyRequirement {
  switch (proposal.kind) {
    case 'scroll':
      return 'NAVIGATE';
    case 'type':
    case 'select':
      return 'INTERACT';
    case 'click':
      return 'SEMANTIC_POLICY';
  }
}
