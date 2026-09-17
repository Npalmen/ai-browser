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
  policyOutcome: InteractionPolicyOutcome;
  grantedAuthority?: InteractionAuthority;
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

export function buildPolicyAuditEvent(input: {
  actionId: string;
  timestamp: number;
  proposal: BoundInteractionProposal;
  policyOutcome: InteractionPolicyOutcome;
  grantedAuthority?: InteractionAuthority;
  resultStatus: InteractionAuditResultStatus;
  errorCode?: InteractionErrorCode;
}): InteractionAuditEvent {
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
    grantedAuthority: input.grantedAuthority,
    resultStatus: input.resultStatus,
    errorCode: input.errorCode,
    ...targetIds,
  };
}

export function buildExecutionAuditEvent(input: {
  actionId: string;
  timestamp: number;
  proposal: BoundInteractionProposal;
  policyOutcome: InteractionPolicyOutcome;
  grantedAuthority: InteractionAuthority;
  resultStatus: InteractionAuditResultStatus;
  errorCode?: InteractionErrorCode;
  documentRevisionAfter?: DocumentRevision;
}): InteractionAuditEvent {
  return {
    ...buildPolicyAuditEvent(input),
    documentRevisionAfter: input.documentRevisionAfter,
  };
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
