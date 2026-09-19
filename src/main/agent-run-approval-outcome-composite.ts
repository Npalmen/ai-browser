import type {
  AgentRunApprovalOutcomePort,
  BeginApprovedExecutionResult,
  TrustedAgentApprovalOutcome,
} from '../agent-run/approval-outcome';

export interface CompositeAgentRunApprovalOutcomePortDependencies {
  task: Pick<AgentRunApprovalOutcomePort, 'notifyApprovalOutcome'>;
  agentRun: AgentRunApprovalOutcomePort;
}

/**
 * Trusted fan-out: task sidecar first, then existing AgentRunCoordinator.
 * V4 workflow remains generic.
 */
export class CompositeAgentRunApprovalOutcomePort implements AgentRunApprovalOutcomePort {
  constructor(private readonly deps: CompositeAgentRunApprovalOutcomePortDependencies) {}

  beginApprovedExecution(approvalId: string): BeginApprovedExecutionResult {
    return this.deps.agentRun.beginApprovedExecution(approvalId);
  }

  notifyApprovalOutcome(approvalId: string, outcome: TrustedAgentApprovalOutcome): void {
    try {
      this.deps.task.notifyApprovalOutcome(approvalId, outcome);
    } catch {
      // Task correlation must not roll back V4/V5 outcome delivery.
    }
    this.deps.agentRun.notifyApprovalOutcome(approvalId, outcome);
  }
}
