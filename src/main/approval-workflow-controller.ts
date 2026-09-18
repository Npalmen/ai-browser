import { ApprovalError } from '../shared/approval-errors';
import type { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import type { ExecuteExecutor } from '../approval/execute-executor';
import type { ApprovalManager } from '../approval/approval-manager';
import type { AgentRunApprovalOutcomePort } from '../agent-run/approval-outcome';
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
  agentRun?: AgentRunApprovalOutcomePort;
}

export class ApprovalWorkflowController {
  constructor(private readonly deps: ApprovalWorkflowControllerDependencies) {}

  async decide(input: ApprovalDecideInput): Promise<ApprovalDecideResult> {
    const decisionResult = this.deps.decisionController.decide(input);
    if (!decisionResult.ok || decisionResult.decision === 'reject') {
      if (decisionResult.ok && decisionResult.decision === 'reject') {
        this.notifyAgentRunSafely(decisionResult.approvalId, 'rejected');
      }
      return decisionResult;
    }

    this.deps.beforeClaim?.();

    const snapshot = this.deps.manager.getSnapshot(decisionResult.approvalId);
    if (snapshot === undefined) {
      return decisionResult;
    }

    const tabId = snapshot.action.tabId;
    const stateBeforeClaim = snapshot.action.state;
    const begin = this.beginApprovedExecutionSafely(decisionResult.approvalId);
    if (begin === 'blocked' || begin === 'ignored') {
      this.failClosedCorrelatedApproval(decisionResult.approvalId, tabId);
      return decisionResult;
    }

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
    this.notifyExecuteResultSafely(decisionResult.approvalId, executeResult);
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
      this.notifyAgentRunSafely(approvalId, 'expired');
      return;
    }
    if (code === 'APPROVAL_STALE') {
      this.emitSafely({ type: 'approval-stale', approvalId, tabId });
      this.notifyAgentRunSafely(approvalId, 'stale');
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

  private notifyExecuteResultSafely(approvalId: string, result: ExecuteResult): void {
    if (result.status === 'executed') {
      this.notifyAgentRunSafely(approvalId, 'executed');
      return;
    }
    if (result.status === 'stale') {
      this.notifyAgentRunSafely(approvalId, 'stale');
      return;
    }
    if (result.status === 'failed') {
      this.notifyAgentRunSafely(approvalId, 'failed');
      return;
    }
    this.notifyAgentRunSafely(approvalId, 'execution-state-unknown');
  }

  private beginApprovedExecutionSafely(approvalId: string): 'proceed' | 'unrelated' | 'blocked' | 'ignored' {
    if (this.deps.agentRun === undefined) {
      return 'unrelated';
    }
    try {
      return this.deps.agentRun.beginApprovedExecution(approvalId);
    } catch {
      return 'ignored';
    }
  }

  private failClosedCorrelatedApproval(approvalId: string, tabId: string): void {
    const snapshot = this.deps.manager.getSnapshot(approvalId);
    const state = snapshot?.action.state;
    if (state === 'pending' || state === 'approved') {
      try {
        this.deps.manager.markStale(approvalId);
      } catch {
        return;
      }
      try {
        this.deps.auditRecorder.recordStale(approvalId);
      } catch {
        // Audit remains observational.
      }
      this.emitSafely({ type: 'approval-stale', approvalId, tabId });
    }
    this.notifyAgentRunSafely(approvalId, 'stale');
  }

  private notifyAgentRunSafely(
    approvalId: string,
    outcome: 'executed' | 'rejected' | 'expired' | 'stale' | 'failed' | 'execution-state-unknown',
  ): void {
    if (this.deps.agentRun === undefined) {
      return;
    }
    try {
      this.deps.agentRun.notifyApprovalOutcome(approvalId, outcome);
    } catch {
      // AgentRun notification is orchestration and must not roll back V4 authority.
    }
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
