import type { BoundInteractionProposal } from '../shared/interaction-types';
import { fingerprintAction, type ActionFingerprintInput } from './action-fingerprint';

export function fingerprintBoundProposal(proposal: BoundInteractionProposal): string {
  return fingerprintAction(toFingerprintInput(proposal));
}

function toFingerprintInput(proposal: BoundInteractionProposal): ActionFingerprintInput {
  switch (proposal.kind) {
    case 'click':
      return {
        kind: 'click',
        documentRevision: proposal.documentRevision,
        targetId: proposal.targetId,
      };
    case 'type':
      return {
        kind: 'type',
        documentRevision: proposal.documentRevision,
        targetId: proposal.targetId,
        text: proposal.text,
      };
    case 'select':
      return {
        kind: 'select',
        documentRevision: proposal.documentRevision,
        targetId: proposal.targetId,
        optionTargetId: proposal.optionTargetId,
      };
    case 'scroll':
      if (proposal.mode === 'viewport') {
        return {
          kind: 'scroll',
          mode: 'viewport',
          documentRevision: proposal.documentRevision,
          direction: proposal.direction,
          amountPx: proposal.amountPx,
        };
      }
      return {
        kind: 'scroll',
        mode: 'into-view',
        documentRevision: proposal.documentRevision,
        targetId: proposal.targetId,
      };
  }
}
