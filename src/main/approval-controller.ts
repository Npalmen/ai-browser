import type {
  ApprovalDecideInput,
  ApprovalDecideResult,
  ApprovalEvent,
  PreparedActionState,
} from '../shared/approval-types';
import type { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import type { ApprovalManager } from '../approval/approval-manager';
import { approvalSafeError, toApprovalSafeError } from './approval-safe-error';

export interface ApprovalControllerDependencies {
  manager: ApprovalManager;
  auditRecorder: ApprovalAuditRecorder;
  emit: (event: ApprovalEvent) => void;
}

export class ApprovalController {
  constructor(private readonly deps: ApprovalControllerDependencies) {}

  decide(input: ApprovalDecideInput): ApprovalDecideResult {
    const previous = this.deps.manager.getSnapshot(input.approvalId);
    if (previous === undefined) {
      return fail('APPROVAL_NOT_FOUND');
    }

    try {
      const decision = this.deps.manager.decide(input.approvalId, input.decision);
      const snapshot = this.deps.manager.getSnapshot(input.approvalId);
      if (snapshot === undefined || (snapshot.action.state !== 'approved' && snapshot.action.state !== 'rejected')) {
        return fail('APPROVAL_FAILED');
      }

      if (decision.decision === 'approve') {
        this.deps.auditRecorder.recordApproved(input.approvalId);
      } else {
        this.deps.auditRecorder.recordRejected(input.approvalId);
      }

      this.deps.emit(
        Object.freeze({
          type: 'approval-resolved',
          approvalId: snapshot.action.approvalId,
          tabId: snapshot.action.tabId,
          decision: decision.decision,
          state: snapshot.action.state,
        }),
      );

      return Object.freeze({
        ok: true,
        approvalId: snapshot.action.approvalId,
        decision: decision.decision,
        state: snapshot.action.state,
      });
    } catch (error) {
      return this.handleDecideFailure(input.approvalId, previous.action.state, previous.action.tabId, error);
    }
  }

  private handleDecideFailure(
    approvalId: string,
    previousState: PreparedActionState,
    tabId: string,
    error: unknown,
  ): ApprovalDecideResult {
    const safe = toApprovalSafeError(error);
    if (safe.code === 'APPROVAL_EXPIRED') {
      if (previousState === 'pending') {
        const current = this.deps.manager.getSnapshot(approvalId);
        if (current?.action.state === 'expired') {
          this.deps.auditRecorder.recordExpired(approvalId);
        }
        this.deps.emit(
          Object.freeze({
            type: 'approval-expired',
            approvalId,
            tabId,
          }),
        );
      }
      return fail('APPROVAL_EXPIRED');
    }

    if (safe.code === 'APPROVAL_STALE') {
      this.deps.emit(
        Object.freeze({
          type: 'approval-stale',
          approvalId,
          tabId,
        }),
      );
      return fail('APPROVAL_STALE');
    }

    return Object.freeze({
      ok: false,
      error: safe,
    });
  }
}

function fail(
  code: 'APPROVAL_NOT_FOUND' | 'APPROVAL_EXPIRED' | 'APPROVAL_STALE' | 'APPROVAL_FAILED',
): ApprovalDecideResult {
  return Object.freeze({
    ok: false,
    error: approvalSafeError(code),
  });
}
