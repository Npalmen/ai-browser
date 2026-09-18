import { ApprovalError } from '../shared/approval-errors';
import type { ApprovalManager } from './approval-manager';
import {
  buildApprovalPresentedAuditEvent,
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
    return this.appendLifecycle('stale', snapshot);
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

  private requireSnapshot(approvalId: string): NonNullable<ReturnType<ApprovalManager['getSnapshot']>> {
    const snapshot = this.deps.manager.getSnapshot(approvalId);
    if (snapshot === undefined) {
      throw new ApprovalError('APPROVAL_NOT_FOUND', `Approval not found: ${approvalId}`);
    }
    return snapshot;
  }
}
