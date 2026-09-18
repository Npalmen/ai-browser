import type {
  ApprovalExecutionFacts,
  ConsequentialActionCategory,
  PreparedAction,
  PreparedActionRecordSnapshot,
} from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';
import type { DocumentRevision, ObservationId, TargetId } from '../shared/observation-types';

export type ApprovalAuditEventType =
  | 'prepared'
  | 'approval-presented'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'execute-grant-issued'
  | 'execution-attempted'
  | 'executed'
  | 'execution-failed'
  | 'post-observation-failed';

export interface ApprovalAuditEvent {
  readonly eventType: ApprovalAuditEventType;
  readonly timestamp: number;
  readonly preparedActionId: string;
  readonly approvalId: string;
  readonly executionId?: string;
  readonly tabId: TabId;
  readonly observationId: ObservationId;
  readonly documentRevision: DocumentRevision;
  readonly targetId: TargetId;
  readonly category: ConsequentialActionCategory;
  readonly grantIssued: boolean;
  readonly grantClaimed: boolean;
  readonly adapterPrimitiveInvoked: boolean;
  readonly postObservationSucceeded: boolean;
}

export interface ApprovalAuditSink {
  append(event: ApprovalAuditEvent): void;
  getEvents(): ReadonlyArray<ApprovalAuditEvent>;
  clear(): void;
}

export class InMemoryApprovalAuditSink implements ApprovalAuditSink {
  private readonly events: ApprovalAuditEvent[] = [];

  append(event: ApprovalAuditEvent): void {
    this.events.push(cloneApprovalAuditEvent(event));
  }

  getEvents(): ReadonlyArray<ApprovalAuditEvent> {
    return Object.freeze(this.events.map((event) => cloneApprovalAuditEvent(event)));
  }

  clear(): void {
    this.events.length = 0;
  }
}

export interface BuildPreparedApprovalAuditEventInput {
  action: PreparedAction;
  facts: ApprovalExecutionFacts;
}

export function buildPreparedApprovalAuditEvent(
  input: BuildPreparedApprovalAuditEventInput,
): ApprovalAuditEvent {
  return buildApprovalAuditEvent({
    eventType: 'prepared',
    timestamp: input.action.createdAt,
    action: input.action,
    facts: input.facts,
  });
}

export interface BuildApprovalPresentedAuditEventInput {
  snapshot: PreparedActionRecordSnapshot;
  timestamp: number;
}

export function buildApprovalPresentedAuditEvent(
  input: BuildApprovalPresentedAuditEventInput,
): ApprovalAuditEvent {
  return buildApprovalAuditEvent({
    eventType: 'approval-presented',
    timestamp: input.timestamp,
    action: input.snapshot.action,
    facts: input.snapshot.facts,
  });
}

export interface BuildLifecycleApprovalAuditEventInput {
  eventType: 'approved' | 'rejected' | 'expired' | 'stale';
  snapshot: PreparedActionRecordSnapshot;
  timestamp: number;
}

export function buildLifecycleApprovalAuditEvent(
  input: BuildLifecycleApprovalAuditEventInput,
): ApprovalAuditEvent {
  return buildApprovalAuditEvent({
    eventType: input.eventType,
    timestamp: input.timestamp,
    action: input.snapshot.action,
    facts: input.snapshot.facts,
  });
}

interface BuildApprovalAuditEventInput {
  eventType: ApprovalAuditEventType;
  timestamp: number;
  action: PreparedAction;
  facts: ApprovalExecutionFacts;
  executionId?: string;
}

function buildApprovalAuditEvent(input: BuildApprovalAuditEventInput): ApprovalAuditEvent {
  validateApprovalAuditEvent(input);

  return Object.freeze({
    eventType: input.eventType,
    timestamp: input.timestamp,
    preparedActionId: input.action.preparedActionId,
    approvalId: input.action.approvalId,
    ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
    tabId: input.action.tabId,
    observationId: input.action.observationId,
    documentRevision: input.action.documentRevision,
    targetId: input.action.targetId,
    category: input.action.category,
    grantIssued: input.facts.grantIssued,
    grantClaimed: input.facts.grantClaimed,
    adapterPrimitiveInvoked: input.facts.adapterPrimitiveInvoked,
    postObservationSucceeded: input.facts.postObservationSucceeded,
  });
}

function validateApprovalAuditEvent(input: BuildApprovalAuditEventInput): void {
  if (!input.action.preparedActionId || !input.action.approvalId) {
    throw new Error('Approval audit event requires preparedActionId and approvalId.');
  }

  if (input.eventType === 'prepared') {
    if (
      input.facts.grantIssued ||
      input.facts.grantClaimed ||
      input.facts.adapterPrimitiveInvoked ||
      input.facts.postObservationSucceeded
    ) {
      throw new Error('Prepared audit event must record all stage facts as false.');
    }
    if (input.executionId !== undefined) {
      throw new Error('Prepared audit event must not include executionId.');
    }
  }

  if (input.eventType === 'approved') {
    if (
      !input.facts.grantIssued ||
      input.facts.grantClaimed ||
      input.facts.adapterPrimitiveInvoked ||
      input.facts.postObservationSucceeded ||
      input.executionId !== undefined
    ) {
      throw new Error('Approved audit event must record grantIssued only.');
    }
  }

  if (input.eventType === 'rejected' || input.eventType === 'expired' || input.eventType === 'stale') {
    if (
      input.facts.grantIssued ||
      input.facts.grantClaimed ||
      input.facts.adapterPrimitiveInvoked ||
      input.facts.postObservationSucceeded ||
      input.executionId !== undefined
    ) {
      throw new Error(`${input.eventType} audit event must record all stage facts as false.`);
    }
  }
}

function cloneApprovalAuditEvent(event: ApprovalAuditEvent): ApprovalAuditEvent {
  return Object.freeze({
    eventType: event.eventType,
    timestamp: event.timestamp,
    preparedActionId: event.preparedActionId,
    approvalId: event.approvalId,
    ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
    tabId: event.tabId,
    observationId: event.observationId,
    documentRevision: event.documentRevision,
    targetId: event.targetId,
    category: event.category,
    grantIssued: event.grantIssued,
    grantClaimed: event.grantClaimed,
    adapterPrimitiveInvoked: event.adapterPrimitiveInvoked,
    postObservationSucceeded: event.postObservationSucceeded,
  });
}
