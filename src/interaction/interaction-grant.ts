import { InteractionError } from '../shared/interaction-errors';
import type {
  BoundInteractionProposal,
  InteractionGrant,
  InteractionPolicyAllowDecision,
  InteractionPolicyDecision,
} from '../shared/interaction-types';

export function isAllowPolicyDecision(
  decision: InteractionPolicyDecision,
): decision is InteractionPolicyAllowDecision {
  return decision.outcome === 'ALLOW_INTERACT' || decision.outcome === 'ALLOW_NAVIGATE';
}

export function issueInteractionGrant(
  decision: InteractionPolicyAllowDecision,
  proposal: BoundInteractionProposal,
  actionId: string,
  issuedAt: number,
): InteractionGrant {
  const grant: InteractionGrant = {
    actionId,
    authority: decision.authority,
    kind: proposal.kind,
    tabId: proposal.tabId,
    observationId: proposal.observationId,
    documentRevision: proposal.documentRevision,
    issuedAt,
    ...(collectGrantTargetIds(proposal)),
  };

  return Object.freeze(grant);
}

export function assertGrantMatchesProposal(
  grant: InteractionGrant,
  proposal: BoundInteractionProposal,
): void {
  if (grant.kind !== proposal.kind) {
    throw new InteractionError('INTERACTION_DENIED', 'Grant does not match the bound proposal kind.');
  }

  if (
    grant.tabId !== proposal.tabId ||
    grant.observationId !== proposal.observationId ||
    grant.documentRevision !== proposal.documentRevision
  ) {
    throw new InteractionError('TARGET_STALE', 'Grant identity does not match the bound proposal.');
  }

  switch (proposal.kind) {
    case 'click':
    case 'type':
      if (grant.targetId !== proposal.targetId) {
        throw new InteractionError('INTERACTION_DENIED', 'Grant target does not match the bound proposal.');
      }
      break;
    case 'select':
      if (grant.targetId !== proposal.targetId || grant.optionTargetId !== proposal.optionTargetId) {
        throw new InteractionError('INTERACTION_DENIED', 'Grant select targets do not match the bound proposal.');
      }
      break;
    case 'scroll':
      if (proposal.mode === 'into-view') {
        if (grant.targetId !== proposal.targetId) {
          throw new InteractionError('INTERACTION_DENIED', 'Grant scroll target does not match the bound proposal.');
        }
      } else if (grant.targetId !== undefined || grant.optionTargetId !== undefined) {
        throw new InteractionError('INTERACTION_DENIED', 'Grant must not carry target ids for viewport scroll.');
      }
      break;
  }
}

function collectGrantTargetIds(
  proposal: BoundInteractionProposal,
): Pick<InteractionGrant, 'targetId' | 'optionTargetId'> {
  switch (proposal.kind) {
    case 'click':
    case 'type':
      return { targetId: proposal.targetId };
    case 'select':
      return {
        targetId: proposal.targetId,
        optionTargetId: proposal.optionTargetId,
      };
    case 'scroll':
      return proposal.mode === 'into-view' ? { targetId: proposal.targetId } : {};
  }
}
