import { ApprovalError } from '../shared/approval-errors';
import type { ApprovalErrorCode } from '../shared/approval-errors';
import type { PreparedAction } from '../shared/approval-types';
import type { BoundClickProposal, BoundInteractionProposal } from '../shared/interaction-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import { classifyInteraction } from '../interaction/interaction-policy';
import type { ApprovalManager } from './approval-manager';
import {
  buildPreparedApprovalAuditEvent,
  type ApprovalAuditSink,
} from './approval-audit';
import { buildPreparedActionSummary, classifyConsequentialCategory } from './approval-summary';

export interface PrepareActionServiceDependencies {
  manager: ApprovalManager;
  audit: ApprovalAuditSink;
}

export interface PrepareActionInput {
  readonly proposal: BoundInteractionProposal;
  readonly observation: PageObservation;
}

export class PrepareActionService {
  constructor(private readonly deps: PrepareActionServiceDependencies) {}

  prepare(input: PrepareActionInput): PreparedAction {
    if (input.proposal.kind !== 'click') {
      throw prepareError('PREPARE_ACTION_UNSUPPORTED_KIND', 'V4 preparation supports click proposals only.');
    }

    const proposal = input.proposal;
    const observation = input.observation;
    assertProposalMatchesObservation(proposal, observation);
    const targetNode = resolveExactTargetNode(observation, proposal.targetId);

    const decision = classifyInteraction({
      proposal,
      observation,
      target: { node: targetNode },
    });
    if (decision.outcome !== 'DEFER_EXECUTE' || decision.errorCode !== 'DEFERRED_TO_EXECUTE') {
      throw prepareError(
        'PREPARE_ACTION_NOT_DEFERRED',
        'Only DEFER_EXECUTE consequential clicks may be prepared.',
      );
    }

    const category = classifyConsequentialCategory(targetNode);
    const summary = buildPreparedActionSummary(category, targetNode, observation.document.url);
    const action = this.deps.manager.prepare({
      tabId: proposal.tabId,
      observationId: proposal.observationId,
      documentRevision: proposal.documentRevision,
      targetId: proposal.targetId,
      category,
      summary,
    });

    const snapshot = this.deps.manager.getSnapshot(action.approvalId);
    if (snapshot === undefined) {
      throw new Error('Prepared action snapshot missing after manager prepare.');
    }

    try {
      this.deps.audit.append(
        buildPreparedApprovalAuditEvent({
          action,
          facts: snapshot.facts,
        }),
      );
    } catch {
      // Audit failure must not roll back a successfully created PreparedAction.
    }

    return action;
  }
}

function assertProposalMatchesObservation(
  proposal: BoundClickProposal,
  observation: PageObservation,
): void {
  if (proposal.tabId !== observation.tabId) {
    throw prepareError('PREPARE_ACTION_IDENTITY_MISMATCH', 'Proposal tabId does not match observation.');
  }
  if (proposal.observationId !== observation.observationId) {
    throw prepareError(
      'PREPARE_ACTION_IDENTITY_MISMATCH',
      'Proposal observationId does not match observation.',
    );
  }
  if (proposal.documentRevision !== observation.document.revision) {
    throw prepareError(
      'PREPARE_ACTION_IDENTITY_MISMATCH',
      'Proposal documentRevision does not match observation.',
    );
  }
}

function resolveExactTargetNode(
  observation: PageObservation,
  targetId: string,
): ObservationNode {
  const matches = observation.nodes.filter((node) => node.targetId === targetId);
  if (matches.length === 0) {
    throw prepareError(
      'PREPARE_ACTION_TARGET_NOT_FOUND',
      'Proposal targetId was not found in the supplied observation.',
    );
  }
  if (matches.length > 1) {
    throw prepareError(
      'PREPARE_ACTION_IDENTITY_MISMATCH',
      'Proposal targetId matched more than one observation node.',
    );
  }
  return matches[0];
}

function prepareError(code: ApprovalErrorCode, message: string): ApprovalError {
  return new ApprovalError(code, message);
}
