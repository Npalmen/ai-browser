import type { AgentRunRef } from '../agent-run/agent-run-types';
import type { TrustedAgentApprovalOutcome } from '../agent-run/approval-outcome';
import type { AutonomousTaskApprovalIntegration } from './autonomous-task-approval-integration';
import type {
  AgentRunTaskApprovalPort,
  AgentRunTaskApprovalPrecheckResult,
  AgentRunTaskApprovalPresentedResult,
} from './agent-run-approval-bridge';

/**
 * Late-bound V6 approval port. Created before AgentRunApprovalBridge, then
 * bound exactly once to AutonomousTaskApprovalIntegration after construction.
 */
export class AutonomousTaskApprovalPortProxy implements AgentRunTaskApprovalPort {
  private integration: AutonomousTaskApprovalIntegration | undefined;
  private bound = false;

  bind(integration: AutonomousTaskApprovalIntegration): void {
    if (this.bound) {
      throw new Error('AutonomousTaskApprovalPortProxy is already bound.');
    }
    this.bound = true;
    this.integration = integration;
  }

  beforePrepare(ref: AgentRunRef): AgentRunTaskApprovalPrecheckResult {
    return this.integration?.beforePrepare(ref) ?? 'unrelated';
  }

  onPresented(ref: AgentRunRef, approvalId: string): AgentRunTaskApprovalPresentedResult {
    return this.integration?.onPresented(ref, approvalId) ?? 'unrelated';
  }

  notifyApprovalOutcome(approvalId: string, outcome: TrustedAgentApprovalOutcome): void {
    this.integration?.notifyApprovalOutcome(approvalId, outcome);
  }
}
