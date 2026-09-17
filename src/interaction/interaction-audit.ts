import type { InteractionErrorCode } from '../shared/interaction-errors';
import type {
  BoundInteractionProposal,
  InteractionAuthority,
  InteractionPolicyOutcome,
} from '../shared/interaction-types';
import type { TabId } from '../shared/browser-types';
import type { DocumentRevision, ObservationId, TargetId } from '../shared/observation-types';

export type InteractionAuditResultStatus = 'succeeded' | 'failed' | 'denied';

export interface InteractionAuditEvent {
  actionId: string;
  timestamp: number;
  proposalKind: BoundInteractionProposal['kind'];
  targetId?: TargetId;
  optionTargetId?: TargetId;
  tabId: TabId;
  observationId: ObservationId;
  documentRevision: DocumentRevision;
  policyOutcome?: InteractionPolicyOutcome;
  grantIssued: boolean;
  grantedAuthority?: InteractionAuthority;
  adapterPrimitiveInvoked: boolean;
  resultStatus: InteractionAuditResultStatus;
  errorCode?: InteractionErrorCode;
  documentRevisionAfter?: DocumentRevision;
}

export interface InteractionAuditSink {
  append(event: InteractionAuditEvent): void;
  getEvents(): ReadonlyArray<InteractionAuditEvent>;
  clear(): void;
}

export class InMemoryInteractionAuditSink implements InteractionAuditSink {
  private readonly events: InteractionAuditEvent[] = [];

  append(event: InteractionAuditEvent): void {
    this.events.push(event);
  }

  getEvents(): ReadonlyArray<InteractionAuditEvent> {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }
}

export interface BuildInteractionAuditEventInput {
  actionId: string;
  timestamp: number;
  proposal: BoundInteractionProposal;
  resultStatus: InteractionAuditResultStatus;
  grantIssued: boolean;
  adapterPrimitiveInvoked: boolean;
  policyOutcome?: InteractionPolicyOutcome;
  grantedAuthority?: InteractionAuthority;
  errorCode?: InteractionErrorCode;
  documentRevisionAfter?: DocumentRevision;
}

export function buildInteractionAuditEvent(input: BuildInteractionAuditEventInput): InteractionAuditEvent {
  validateInteractionAuditEventInput(input);

  const { proposal } = input;
  const targetIds = collectAuditTargetIds(proposal);

  return {
    actionId: input.actionId,
    timestamp: input.timestamp,
    proposalKind: proposal.kind,
    tabId: proposal.tabId,
    observationId: proposal.observationId,
    documentRevision: proposal.documentRevision,
    policyOutcome: input.policyOutcome,
    grantIssued: input.grantIssued,
    grantedAuthority: input.grantedAuthority,
    adapterPrimitiveInvoked: input.adapterPrimitiveInvoked,
    resultStatus: input.resultStatus,
    errorCode: input.errorCode,
    documentRevisionAfter: input.documentRevisionAfter,
    ...targetIds,
  };
}

export function validateInteractionAuditEventInput(input: BuildInteractionAuditEventInput): void {
  if (!input.grantIssued && input.grantedAuthority !== undefined) {
    throw new Error('Audit event cannot include grantedAuthority when grantIssued is false.');
  }

  if (!input.grantIssued && input.adapterPrimitiveInvoked) {
    throw new Error('Audit event cannot mark adapterPrimitiveInvoked without an issued grant.');
  }

  if (input.grantIssued && input.policyOutcome !== 'ALLOW_INTERACT' && input.policyOutcome !== 'ALLOW_NAVIGATE') {
    throw new Error('Audit event cannot mark grantIssued without an allow policy outcome.');
  }

  if (
    (input.policyOutcome === 'DENY' || input.policyOutcome === 'DEFER_EXECUTE') &&
    input.grantIssued
  ) {
    throw new Error('Audit event cannot mark grantIssued for a deny or defer policy outcome.');
  }

  if (
    (input.policyOutcome === 'DENY' || input.policyOutcome === 'DEFER_EXECUTE') &&
    input.adapterPrimitiveInvoked
  ) {
    throw new Error('Audit event cannot mark adapterPrimitiveInvoked for a deny or defer policy outcome.');
  }

  if (input.resultStatus === 'denied' && input.policyOutcome !== 'DENY' && input.policyOutcome !== 'DEFER_EXECUTE') {
    throw new Error('Audit event resultStatus denied requires a policy deny or defer outcome.');
  }
}

function collectAuditTargetIds(
  proposal: BoundInteractionProposal,
): Pick<InteractionAuditEvent, 'targetId' | 'optionTargetId'> {
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
