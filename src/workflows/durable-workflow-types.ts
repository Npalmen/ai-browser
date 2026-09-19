import type {
  DurableWorkflowDefinitionRecord,
  WorkflowOccurrenceRecord,
  WorkflowStoreMutation,
  WorkflowStoreSnapshot,
  WorkflowTriggerRecord,
  WorkflowUrlEntryPointRecord,
} from './workflow-store-types';

export type DurableWorkflowId = string;
export type WorkflowOccurrenceId = string;

export const MAX_WORKFLOW_TRANSACTION_RETRIES = 3;
export const MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW = 50;
export const MAX_SCHEDULED_DEDUPE_ANCHORS_PER_WORKFLOW = 1;
export const MAX_WORKFLOW_ID_REGENERATIONS = 3;

export const WORKFLOW_TERMINAL_REASON = Object.freeze({
  COMPLETED: 'COMPLETED',
  INTERRUPTED: 'INTERRUPTED',
  USER_CANCELLED: 'USER_CANCELLED',
  EXECUTION_STATE_UNKNOWN: 'EXECUTION_STATE_UNKNOWN',
});

export type WorkflowEnqueueSource = 'manual' | 'scheduled';

export type RunningOccurrenceTerminalState =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'execution-state-unknown';

export interface WorkflowStorePort {
  load(): Promise<WorkflowStoreSnapshot>;
  commit(
    expectedStoreRevision: number,
    mutation: WorkflowStoreMutation,
  ): Promise<WorkflowStoreSnapshot>;
}

export interface CreateDurableWorkflowInput {
  readonly name: string;
  readonly objective: string;
  readonly entryPoint: WorkflowUrlEntryPointRecord;
  readonly trigger: WorkflowTriggerRecord;
  readonly enabled?: boolean;
}

export interface EditDurableWorkflowInput {
  readonly name: string;
  readonly objective: string;
  readonly entryPoint: WorkflowUrlEntryPointRecord;
  readonly trigger: WorkflowTriggerRecord;
}

export interface EnqueueScheduledOccurrenceInput {
  readonly workflowId: DurableWorkflowId;
  readonly scheduledFor: string;
}

export interface TerminalizeRunningOccurrenceInput {
  readonly occurrenceId: WorkflowOccurrenceId;
  readonly state: RunningOccurrenceTerminalState;
  readonly terminalReason?: string | null;
  readonly finalAnswer?: string | null;
}

export interface DurableWorkflowCoordinatorOptions {
  readonly store: WorkflowStorePort;
  readonly now?: () => Date;
  readonly newWorkflowId?: () => string;
  readonly newOccurrenceId?: () => string;
}

export type { DurableWorkflowDefinitionRecord, WorkflowOccurrenceRecord };
