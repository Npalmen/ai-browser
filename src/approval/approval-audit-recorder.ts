import { ApprovalError } from '../shared/approval-errors';
import type { ApprovalManager } from './approval-manager';
import {
  buildApprovalPresentedAuditEvent,
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
    const snapshot = this.deps.manager.getSnapshot(approvalId);
    if (snapshot === undefined) {
      throw new ApprovalError('APPROVAL_NOT_FOUND', `Approval not found: ${approvalId}`);
    }
    if (snapshot.action.state !== 'pending') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'approval-presented requires a pending prepared action.',
      );
    }

    const event = buildApprovalPresentedAuditEvent({
      snapshot,
      timestamp: this.now(),
    });
    this.deps.audit.append(event);
    return event;
  }
}
