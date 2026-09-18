import { ApprovalError } from '../shared/approval-errors';
import type { ApprovalManager } from './approval-manager';
import {
  buildApprovalPresentedAuditEvent,
  buildExecutionApprovalAuditEvent,
  buildLifecycleApprovalAuditEvent,
  type ApprovalAuditEvent,
  type ApprovalAuditSink,
} from './approval-audit';

export interface ApprovalAuditRecorderDependencies {
  manager: ApprovalManager;
  audit: ApprovalAuditSink;
  now?: () => number;
}

export class ApprovalAuditRecorder {
  private readonly now: () => number;

  constructor(private readonly deps: ApprovalAuditRecorderDependencies) {
    this.now = deps.now ?? Date.now;
  }

  recordApprovalPresented(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    const presentedAt = this.now();
    if (presentedAt >= snapshot.action.expiresAt) {
      throw new ApprovalError('APPROVAL_EXPIRED', 'Approval has expired.');
    }
    if (snapshot.action.state !== 'pending') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'approval-presented requires a pending prepared action.',
      );
    }

    const event = buildApprovalPresentedAuditEvent({
      snapshot,
      timestamp: presentedAt,
    });
    this.deps.audit.append(event);
    return event;
  }

  recordApproved(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (snapshot.action.state !== 'approved') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'approved audit requires an approved action.',
      );
    }
    return this.appendLifecycle('approved', snapshot, snapshot.decision?.decidedAt);
  }

  recordRejected(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (snapshot.action.state !== 'rejected') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'rejected audit requires a rejected action.',
      );
    }
    return this.appendLifecycle('rejected', snapshot, snapshot.decision?.decidedAt);
  }

  recordExpired(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (snapshot.action.state !== 'expired') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'expired audit requires an expired action.',
      );
    }
    return this.appendLifecycle('expired', snapshot);
  }

  recordStale(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (snapshot.action.state !== 'stale') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'stale audit requires a stale action.',
      );
    }
    if (snapshot.facts.adapterPrimitiveInvoked) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'stale audit cannot record adapter dispatch.',
      );
    }
    if (snapshot.facts.grantClaimed) {
      return this.appendExecution('stale', snapshot);
    }
    return this.appendLifecycle('stale', snapshot);
  }

  recordExecuteGrantIssued(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (snapshot.action.state !== 'executing' || snapshot.executionGrant === undefined) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'execute-grant-issued requires an executing claimed grant.',
      );
    }
    if (
      snapshot.facts.grantIssued !== true ||
      snapshot.facts.grantClaimed !== true ||
      snapshot.facts.adapterPrimitiveInvoked !== false ||
      snapshot.facts.postObservationSucceeded !== false
    ) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'execute-grant-issued requires a claimed unused grant before adapter dispatch.',
      );
    }
    return this.appendExecution('execute-grant-issued', snapshot, snapshot.executionGrant.issuedAt);
  }

  recordExecutionAttempted(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (
      snapshot.facts.grantIssued !== true ||
      snapshot.facts.grantClaimed !== true ||
      snapshot.facts.adapterPrimitiveInvoked !== true ||
      snapshot.facts.postObservationSucceeded !== false ||
      snapshot.executionGrant === undefined
    ) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'execution-attempted requires adapter dispatch without a successful post-observation.',
      );
    }
    return this.appendExecution('execution-attempted', snapshot);
  }

  recordExecutionFailed(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (snapshot.action.state !== 'failed') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'execution-failed audit requires a failed action.',
      );
    }
    if (
      snapshot.facts.grantIssued !== true ||
      snapshot.facts.grantClaimed !== true ||
      snapshot.facts.adapterPrimitiveInvoked !== false ||
      snapshot.facts.postObservationSucceeded !== false ||
      snapshot.executionGrant === undefined
    ) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'execution-failed is strictly pre-dispatch.',
      );
    }
    return this.appendExecution('execution-failed', snapshot);
  }

  recordExecuted(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (snapshot.action.state !== 'executed') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'executed audit requires an executed action.',
      );
    }
    if (
      snapshot.facts.grantIssued !== true ||
      snapshot.facts.grantClaimed !== true ||
      snapshot.facts.adapterPrimitiveInvoked !== true ||
      snapshot.facts.postObservationSucceeded !== true ||
      snapshot.executionGrant === undefined
    ) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'executed audit requires adapter dispatch and a successful post-observation.',
      );
    }
    return this.appendExecution('executed', snapshot);
  }

  recordPostObservationFailed(approvalId: string): ApprovalAuditEvent {
    const snapshot = this.requireSnapshot(approvalId);
    if (snapshot.action.state !== 'execution-attempted-state-unknown') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'post-observation-failed requires execution-attempted-state-unknown.',
      );
    }
    if (
      snapshot.facts.grantIssued !== true ||
      snapshot.facts.grantClaimed !== true ||
      snapshot.facts.adapterPrimitiveInvoked !== true ||
      snapshot.facts.postObservationSucceeded !== false ||
      snapshot.executionGrant === undefined
    ) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'post-observation-failed requires adapter dispatch without a successful post-observation.',
      );
    }
    return this.appendExecution('post-observation-failed', snapshot);
  }

  private appendLifecycle(
    eventType: 'approved' | 'rejected' | 'expired' | 'stale',
    snapshot: NonNullable<ReturnType<ApprovalManager['getSnapshot']>>,
    timestamp?: number,
  ): ApprovalAuditEvent {
    const event = buildLifecycleApprovalAuditEvent({
      eventType,
      snapshot,
      timestamp: timestamp ?? this.now(),
    });
    this.deps.audit.append(event);
    return event;
  }

  private appendExecution(
    eventType:
      | 'execute-grant-issued'
      | 'execution-attempted'
      | 'execution-failed'
      | 'executed'
      | 'post-observation-failed'
      | 'stale',
    snapshot: NonNullable<ReturnType<ApprovalManager['getSnapshot']>>,
    timestamp?: number,
  ): ApprovalAuditEvent {
    const event = buildExecutionApprovalAuditEvent({
      eventType,
      snapshot,
      timestamp: timestamp ?? this.now(),
    });
    this.deps.audit.append(event);
    return event;
  }

  private requireSnapshot(approvalId: string): NonNullable<ReturnType<ApprovalManager['getSnapshot']>> {
    const snapshot = this.deps.manager.getSnapshot(approvalId);
    if (snapshot === undefined) {
      throw new ApprovalError('APPROVAL_NOT_FOUND', `Approval not found: ${approvalId}`);
    }
    return snapshot;
  }
}
