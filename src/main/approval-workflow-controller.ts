import { ApprovalError } from '../shared/approval-errors';
import type { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import type { ExecuteExecutor } from '../approval/execute-executor';
import type { ApprovalManager } from '../approval/approval-manager';
import type {
  ApprovalDecideInput,
  ApprovalDecideResult,
  ApprovalEvent,
  ExecuteResult,
  PreparedActionState,
} from '../shared/approval-types';
import type { ApprovalController } from './approval-controller';
import { approvalSafeError } from './approval-safe-error';

export interface ApprovalWorkflowControllerDependencies {
  decisionController: ApprovalController;
  manager: ApprovalManager;
  executeExecutor: Pick<ExecuteExecutor, 'execute'>;
  auditRecorder: ApprovalAuditRecorder;
  emit: (event: ApprovalEvent) => void;
  beforeClaim?: () => void;
}

export class ApprovalWorkflowController {
  constructor(private readonly deps: ApprovalWorkflowControllerDependencies) {}

  async decide(input: ApprovalDecideInput): Promise<ApprovalDecideResult> {
    const decisionResult = this.deps.decisionController.decide(input);
    if (!decisionResult.ok || decisionResult.decision === 'reject') {
      return decisionResult;
    }

    this.deps.beforeClaim?.();

    const snapshot = this.deps.manager.getSnapshot(decisionResult.approvalId);
    if (snapshot === undefined) {
      return decisionResult;
    }

    const tabId = snapshot.action.tabId;
    const stateBeforeClaim = snapshot.action.state;
    let grant;
    try {
      grant = this.deps.manager.claimExecuteGrant(decisionResult.approvalId);
    } catch (error: unknown) {
      this.handleClaimFailure(decisionResult.approvalId, tabId, stateBeforeClaim, error);
      return decisionResult;
    }

    this.emitSafely({
      type: 'execution-started',
      approvalId: decisionResult.approvalId,
      tabId,
    });

    const executeResult = await this.deps.executeExecutor.execute(grant);
    this.emitExecutionOutcome(decisionResult.approvalId, tabId, executeResult);
    return decisionResult;
  }

  private handleClaimFailure(
    approvalId: string,
    tabId: string,
    stateBeforeClaim: PreparedActionState | undefined,
    error: unknown,
  ): void {
    const code = error instanceof ApprovalError ? error.code : undefined;
    if (code === 'APPROVAL_EXPIRED') {
      if (stateBeforeClaim === 'approved') {
        this.recordExpiredSafely(approvalId);
      }
      this.emitSafely({ type: 'approval-expired', approvalId, tabId });
      return;
    }
    if (code === 'APPROVAL_STALE') {
      this.emitSafely({ type: 'approval-stale', approvalId, tabId });
    }
  }

  private emitExecutionOutcome(approvalId: string, tabId: string, result: ExecuteResult): void {
    if (result.status === 'executed') {
      this.emitSafely({
        type: 'execution-completed',
        approvalId,
        tabId,
      });
      return;
    }

    this.emitSafely({
      type: 'execution-failed',
      approvalId,
      tabId,
      status: result.status,
      error:
        result.status === 'stale'
          ? approvalSafeError('APPROVAL_STALE')
          : result.status === 'execution-attempted-state-unknown'
            ? approvalSafeError('EXECUTION_STATE_UNKNOWN')
            : approvalSafeError('EXECUTION_FAILED'),
    });
  }

  private emitSafely(event: ApprovalEvent): void {
    try {
      this.deps.emit(event);
    } catch {
      // Event emission must not roll back a committed decision or retry execution.
    }
  }

  private recordExpiredSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordExpired(approvalId);
    } catch {
      // Audit remains observational.
    }
  }
}
