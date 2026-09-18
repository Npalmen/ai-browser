import type { AgentRunSnapshot } from './agent-run-types';

export type TrustedAgentApprovalOutcome =
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'failed'
  | 'execution-state-unknown';

export type BeginApprovedExecutionResult = 'proceed' | 'unrelated' | 'blocked' | 'ignored';

export type AgentRunApprovalWaitResult =
  | {
      readonly status: 'resolved';
      readonly snapshot: AgentRunSnapshot;
    }
  | {
      readonly status: 'ignored';
    };

export interface AgentRunApprovalOutcomePort {
  beginApprovedExecution(approvalId: string): BeginApprovedExecutionResult;
  notifyApprovalOutcome(
    approvalId: string,
    outcome: TrustedAgentApprovalOutcome,
  ): void;
}
