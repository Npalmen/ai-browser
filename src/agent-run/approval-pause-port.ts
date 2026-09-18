import type { BoundInteractionProposal } from '../shared/interaction-types';
import type { PageObservation } from '../shared/observation-types';
import type { AgentRunRef } from './agent-run-types';

export type AgentRunApprovalPrepareResult =
  | {
      readonly status: 'awaiting-approval';
      readonly approvalId: string;
    }
  | {
      readonly status: 'expired';
    }
  | {
      readonly status: 'stale';
    }
  | {
      readonly status: 'failed';
    }
  | {
      readonly status: 'ignored';
    };

export interface AgentRunApprovalPort {
  prepareAndPresent(input: {
    ref: AgentRunRef;
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): AgentRunApprovalPrepareResult;
}
