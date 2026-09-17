import { InteractionError } from '../shared/interaction-errors';
import type {
  BoundInteractionIdentity,
  BoundInteractionProposal,
  ModelInteractionProposal,
} from '../shared/interaction-types';
import type { PageObservation, TargetId } from '../shared/observation-types';

export interface BindInteractionProposalInput {
  proposal: ModelInteractionProposal;
  observation: PageObservation;
  exportedTargetIds: ReadonlySet<TargetId>;
}

export function bindInteractionProposal(
  input: BindInteractionProposalInput,
): BoundInteractionProposal {
  const { proposal, observation, exportedTargetIds } = input;

  for (const targetId of collectTargetIds(proposal)) {
    if (!exportedTargetIds.has(targetId)) {
      throw new InteractionError(
        'TARGET_NOT_EXPORTED',
        `Target ${targetId} was not exported to the model context.`,
      );
    }
  }

  const identity: BoundInteractionIdentity = {
    tabId: observation.tabId,
    observationId: observation.observationId,
    documentRevision: observation.document.revision,
  };

  switch (proposal.kind) {
    case 'click':
      return {
        kind: 'click',
        targetId: proposal.targetId,
        ...identity,
      };
    case 'type':
      return {
        kind: 'type',
        targetId: proposal.targetId,
        text: proposal.text,
        ...identity,
      };
    case 'select':
      return {
        kind: 'select',
        targetId: proposal.targetId,
        optionTargetId: proposal.optionTargetId,
        ...identity,
      };
    case 'scroll':
      if (proposal.mode === 'viewport') {
        return {
          kind: 'scroll',
          mode: 'viewport',
          direction: proposal.direction,
          amountPx: proposal.amountPx,
          ...identity,
        };
      }

      return {
        kind: 'scroll',
        mode: 'into-view',
        targetId: proposal.targetId,
        ...identity,
      };
  }
}

function collectTargetIds(proposal: ModelInteractionProposal): TargetId[] {
  switch (proposal.kind) {
    case 'click':
    case 'type':
      return [proposal.targetId];
    case 'select':
      return [proposal.targetId, proposal.optionTargetId];
    case 'scroll':
      return proposal.mode === 'into-view' ? [proposal.targetId] : [];
  }
}
