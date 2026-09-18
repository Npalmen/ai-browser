import type { TabId } from './browser-types';
import type { DocumentRevision, ObservationId, TargetId } from './observation-types';

/** Fixed 2-minute TTL. Correctness is clock-checked on transitions, not timers. */
export const PREPARED_ACTION_TTL_MS = 120_000;

export const CONSEQUENTIAL_ACTION_CATEGORIES = [
  'submit',
  'send',
  'purchase',
  'delete',
  'publish',
  'book',
  'reserve',
  'account-change',
  'other-consequential',
] as const;

export type ConsequentialActionCategory = (typeof CONSEQUENTIAL_ACTION_CATEGORIES)[number];

export interface PreparedActionSummary {
  readonly title: string;
  readonly description?: string;
  readonly origin?: string;
}

export type PreparedActionState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'executing'
  | 'failed'
  | 'executed'
  | 'execution-attempted-state-unknown';

export const TERMINAL_PREPARED_ACTION_STATES: ReadonlySet<PreparedActionState> = new Set([
  'rejected',
  'expired',
  'stale',
  'failed',
  'executed',
  'execution-attempted-state-unknown',
]);

export type ExecuteKind = 'click';
export type ExecuteAuthority = 'EXECUTE';

export interface PreparedAction {
  readonly preparedActionId: string;
  readonly approvalId: string;
  readonly kind: ExecuteKind;
  readonly tabId: TabId;
  readonly observationId: ObservationId;
  readonly documentRevision: DocumentRevision;
  readonly targetId: TargetId;
  readonly category: ConsequentialActionCategory;
  readonly summary: PreparedActionSummary;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: PreparedActionState;
}

export type ApprovalDecisionValue = 'approve' | 'reject';

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly preparedActionId: string;
  readonly decision: ApprovalDecisionValue;
  readonly decidedAt: number;
}

export interface ExecuteGrant {
  readonly executionId: string;
  readonly preparedActionId: string;
  readonly approvalId: string;
  readonly authority: ExecuteAuthority;
  readonly kind: ExecuteKind;
  readonly tabId: TabId;
  readonly observationId: ObservationId;
  readonly documentRevision: DocumentRevision;
  readonly targetId: TargetId;
  readonly issuedAt: number;
}

export interface ApprovalExecutionFacts {
  readonly grantIssued: boolean;
  readonly grantClaimed: boolean;
  readonly adapterPrimitiveInvoked: boolean;
  readonly postObservationSucceeded: boolean;
}

export interface PreparedActionRecordSnapshot {
  readonly action: PreparedAction;
  readonly decision?: ApprovalDecision;
  readonly executionGrant?: ExecuteGrant;
  readonly facts: ApprovalExecutionFacts;
}

export interface PreparePreparedActionInput {
  readonly tabId: TabId;
  readonly observationId: ObservationId;
  readonly documentRevision: DocumentRevision;
  readonly targetId: TargetId;
  readonly category: ConsequentialActionCategory;
  readonly summary: PreparedActionSummary;
}
