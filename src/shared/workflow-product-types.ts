export type WorkflowRuntimeStatus = 'ready' | 'storage-error' | 'not-initialized';

export type WorkflowProductErrorCode =
  | 'WORKFLOW_NOT_AVAILABLE'
  | 'WORKFLOW_INVALID_REQUEST'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_DISABLED'
  | 'WORKFLOW_REVIEW_REQUIRED'
  | 'WORKFLOW_RUNNING'
  | 'WORKFLOW_BUSY'
  | 'WORKFLOW_STORAGE_ERROR'
  | 'WORKFLOW_CONCURRENT_MODIFICATION'
  | 'WORKFLOW_OPERATION_FAILED';

export interface WorkflowProductError {
  readonly code: WorkflowProductErrorCode;
  readonly message: string;
}

export type WorkflowProductTrigger =
  | {
      readonly kind: 'manual';
    }
  | {
      readonly kind: 'schedule';
      readonly schedule:
        | {
            readonly kind: 'one-time';
            readonly runAtUtc: string;
          }
        | {
            readonly kind: 'recurring-daily';
            readonly timeZone: string;
            readonly hour: number;
            readonly minute: number;
          }
        | {
            readonly kind: 'recurring-weekly';
            readonly timeZone: string;
            readonly hour: number;
            readonly minute: number;
            readonly daysOfWeek: readonly number[];
          };
    };

export interface WorkflowProductEntryPoint {
  readonly kind: 'url';
  readonly url: string;
}

export type WorkflowTerminalResultState =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'execution-state-unknown'
  | 'interrupted';

export interface WorkflowLastResultView {
  readonly state: WorkflowTerminalResultState;
  readonly finishedAt: string;
  readonly finalAnswer?: string;
  readonly terminalReason?: string;
}

export interface WorkflowSummaryView {
  readonly workflowId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly reviewRequired: boolean;
  readonly definitionRevision: number;
  readonly trigger: WorkflowProductTrigger;
  readonly nextRunAt: string | null;
  readonly queuedCount: number;
  readonly running: boolean;
  readonly lastResult: WorkflowLastResultView | null;
}

export type WorkflowOccurrenceStateView =
  | 'queued'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'execution-state-unknown'
  | 'interrupted';

export interface WorkflowOccurrenceView {
  readonly occurrenceId: string;
  readonly state: WorkflowOccurrenceStateView;
  readonly source: 'manual' | 'scheduled';
  readonly scheduledFor: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly terminalReason?: string;
  readonly finalAnswer?: string;
}

export interface WorkflowDetailView {
  readonly workflowId: string;
  readonly definitionRevision: number;
  readonly name: string;
  readonly objective: string;
  readonly entryPoint: WorkflowProductEntryPoint;
  readonly trigger: WorkflowProductTrigger;
  readonly enabled: boolean;
  readonly reviewRequired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt: string | null;
  readonly occurrences: readonly WorkflowOccurrenceView[];
}

export type WorkflowGetStateResult =
  | {
      readonly ok: true;
      readonly status: WorkflowRuntimeStatus;
      readonly workflows: readonly WorkflowSummaryView[];
    }
  | {
      readonly ok: false;
      readonly error: WorkflowProductError;
    };

export type WorkflowGetDetailResult =
  | {
      readonly ok: true;
      readonly workflow: WorkflowDetailView;
    }
  | {
      readonly ok: false;
      readonly error: WorkflowProductError;
    };

export type WorkflowMutationResult =
  | {
      readonly ok: true;
      readonly workflowId?: string;
    }
  | {
      readonly ok: false;
      readonly error: WorkflowProductError;
    };

export interface WorkflowIdInput {
  readonly workflowId: string;
}

export interface WorkflowCreateInput {
  readonly name: string;
  readonly objective: string;
  readonly entryPoint: WorkflowProductEntryPoint;
  readonly trigger: WorkflowProductTrigger;
  readonly enabled?: boolean;
}

export interface WorkflowEditInput {
  readonly workflowId: string;
  readonly name: string;
  readonly objective: string;
  readonly entryPoint: WorkflowProductEntryPoint;
  readonly trigger: WorkflowProductTrigger;
}

export interface WorkflowSetEnabledInput {
  readonly workflowId: string;
  readonly enabled: boolean;
}

export interface WorkflowOccurrenceActionInput {
  readonly workflowId: string;
  readonly occurrenceId: string;
}

export interface WorkflowsApi {
  getState(): Promise<WorkflowGetStateResult>;
  getDetail(input: WorkflowIdInput): Promise<WorkflowGetDetailResult>;
  create(input: WorkflowCreateInput): Promise<WorkflowMutationResult>;
  edit(input: WorkflowEditInput): Promise<WorkflowMutationResult>;
  setEnabled(input: WorkflowSetEnabledInput): Promise<WorkflowMutationResult>;
  runNow(input: WorkflowIdInput): Promise<WorkflowMutationResult>;
  acknowledgeReview(input: WorkflowIdInput): Promise<WorkflowMutationResult>;
  stop(input: WorkflowIdInput): Promise<WorkflowMutationResult>;
  cancelQueued(input: WorkflowOccurrenceActionInput): Promise<WorkflowMutationResult>;
  delete(input: WorkflowIdInput): Promise<WorkflowMutationResult>;
  onStateChanged(listener: () => void): () => void;
}
