import type { BoundInteractionProposal, InteractionResult } from '../shared/interaction-types';
import type { PageObservation } from '../shared/observation-types';

export interface ApprovalRequiredExecutionResult {
  readonly status: 'approval-required';
}

export type InteractiveExecutionResult = InteractionResult | ApprovalRequiredExecutionResult;

export interface InteractionExecutionPort {
  execute(input: {
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): Promise<InteractiveExecutionResult>;
}
