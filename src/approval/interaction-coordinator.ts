import type { InteractionExecutionPort, InteractiveExecutionResult } from '../ai/interactive-agent';
import type { PreparedAction } from '../shared/approval-types';
import { InteractionError } from '../shared/interaction-errors';
import type { BoundInteractionProposal, InteractionResult } from '../shared/interaction-types';
import type { PageObservation } from '../shared/observation-types';
import type { PrepareActionService } from './prepare-action-service';

export interface ApprovalPresenter {
  present(action: PreparedAction): boolean;
}

export interface InteractionCoordinatorDependencies {
  interactionExecutor: InteractionExecutionPort;
  prepareActionService: PrepareActionService;
  approvalPresenter: ApprovalPresenter;
}

export class InteractionCoordinator implements InteractionExecutionPort {
  constructor(private readonly deps: InteractionCoordinatorDependencies) {}

  async execute(input: {
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): Promise<InteractiveExecutionResult> {
    const result = await this.deps.interactionExecutor.execute(input);
    if (!isDeferredExecuteDenial(result)) {
      return result;
    }
    if (input.proposal.kind !== 'click') {
      return result;
    }
    if (input.signal?.aborted) {
      throw new InteractionError('REQUEST_CANCELLED', 'The request was cancelled.');
    }

    const action = this.deps.prepareActionService.prepare({
      proposal: input.proposal,
      observation: input.observation,
    });

    if (input.signal?.aborted) {
      throw new InteractionError('REQUEST_CANCELLED', 'The request was cancelled.');
    }

    const presented = this.deps.approvalPresenter.present(action);
    if (!presented) {
      return result;
    }

    return { status: 'approval-required' };
  }
}

function isDeferredExecuteDenial(result: InteractiveExecutionResult): result is InteractionResult {
  return result.status === 'denied' && result.errorCode === 'DEFERRED_TO_EXECUTE';
}
