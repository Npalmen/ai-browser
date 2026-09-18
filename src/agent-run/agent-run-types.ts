import type { TabId } from '../shared/browser-types';

export const MAX_AGENT_LOOP_MODEL_STEPS = 8;
export const MAX_AGENT_LOOP_ACTION_ATTEMPTS = 6;
export const MAX_AGENT_LOOP_APPROVALS = 2;

export type AgentRunId = string;

export type AgentRunState =
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'cancelled'
  | 'blocked'
  | 'failed'
  | 'execution-state-unknown';

export const TERMINAL_AGENT_RUN_STATES = Object.freeze([
  'completed',
  'cancelled',
  'blocked',
  'failed',
  'execution-state-unknown',
] as const satisfies ReadonlyArray<AgentRunState>);

export type TerminalAgentRunState = (typeof TERMINAL_AGENT_RUN_STATES)[number];

export function isTerminalAgentRunState(state: AgentRunState): state is TerminalAgentRunState {
  return (TERMINAL_AGENT_RUN_STATES as readonly AgentRunState[]).includes(state);
}

export interface AgentRunRef {
  readonly runId: AgentRunId;
  readonly tabId: TabId;
  readonly generation: number;
}

export type AgentRunBlockedReason =
  | 'STEP_LIMIT_REACHED'
  | 'AGENT_LOOP_NO_PROGRESS'
  | 'POLICY_BLOCKED'
  | 'UNSUPPORTED_ACTION'
  | 'ACTION_STALE'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED';

export type AgentRunCancelledReason =
  | 'USER_CANCELLED'
  | 'SUPERSEDED'
  | 'TAB_CLOSED'
  | 'RENDERER_CRASH'
  | 'TRUSTED_CHROME_NAVIGATION';

export type AgentRunFailedReason = 'MODEL_FAILED' | 'ACTION_FAILED';

export type AgentRunUnknownReason = 'EXECUTION_STATE_UNKNOWN';

export type AgentRunCompletedReason = 'COMPLETED';

export type AgentRunTerminalReason =
  | AgentRunBlockedReason
  | AgentRunCancelledReason
  | AgentRunFailedReason
  | AgentRunUnknownReason
  | AgentRunCompletedReason;

export interface AgentRunSnapshot {
  readonly runId: AgentRunId;
  readonly tabId: TabId;
  readonly generation: number;
  readonly instruction: string;
  readonly startedAt: number;
  readonly state: AgentRunState;
  readonly modelStepCount: number;
  readonly actionAttemptCount: number;
  readonly approvalCount: number;
  readonly terminalReason?: AgentRunTerminalReason;
  readonly lastSuccessfulActionFingerprint?: string;
}

export type AgentRunRefStatus =
  | { readonly status: 'current'; readonly snapshot: AgentRunSnapshot }
  | { readonly status: 'terminal'; readonly snapshot: AgentRunSnapshot }
  | { readonly status: 'superseded'; readonly snapshot: AgentRunSnapshot }
  | { readonly status: 'missing' };

export type AgentRunMutationResult =
  | { readonly status: 'applied'; readonly snapshot: AgentRunSnapshot }
  | { readonly status: 'ignored' };

export function toAgentRunRef(snapshot: AgentRunSnapshot): AgentRunRef {
  return Object.freeze({
    runId: snapshot.runId,
    tabId: snapshot.tabId,
    generation: snapshot.generation,
  });
}

export function isAgentRunApplied(
  result: AgentRunMutationResult,
): result is Extract<AgentRunMutationResult, { status: 'applied' }> {
  return result.status === 'applied';
}
