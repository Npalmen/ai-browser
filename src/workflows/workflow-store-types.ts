export const WORKFLOW_STORE_SCHEMA_VERSION = 1 as const;

/** Conservative cap for definitions plus history (50 terminal occurrences per workflow, plus nonterminal). */
export const MAX_WORKFLOW_STORE_BYTES = 8 * 1024 * 1024;

export const MAX_WORKFLOW_ID_CHARS = 128;
export const MAX_OCCURRENCE_ID_CHARS = 128;
export const MAX_TRIGGER_KEY_CHARS = 256;
export const MAX_RUNTIME_SESSION_ID_CHARS = 128;
export const MAX_WORKFLOW_NAME_CHARS = 200;
/** Same conservative bound as V6 task objectives (`MAX_AUTONOMOUS_TASK_OBJECTIVE_CHARS`). */
export const MAX_WORKFLOW_OBJECTIVE_CHARS = 4000;
export const MAX_WORKFLOW_ENTRY_URL_CHARS = 2048;
export const MAX_WORKFLOW_TIMEZONE_CHARS = 128;
export const MAX_TERMINAL_REASON_CHARS = 128;
/** Same conservative bound as V6 task answers (`MAX_AUTONOMOUS_TASK_ANSWER_CHARS`). */
export const MAX_WORKFLOW_FINAL_ANSWER_CHARS = 4000;

export const WORKFLOW_OCCURRENCE_STATES = Object.freeze([
  'queued',
  'running',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'execution-state-unknown',
  'interrupted',
] as const);

export type WorkflowOccurrenceState = (typeof WORKFLOW_OCCURRENCE_STATES)[number];

export const TERMINAL_WORKFLOW_OCCURRENCE_STATES = Object.freeze([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'execution-state-unknown',
  'interrupted',
] as const satisfies ReadonlyArray<WorkflowOccurrenceState>);

export type TerminalWorkflowOccurrenceState = (typeof TERMINAL_WORKFLOW_OCCURRENCE_STATES)[number];

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WorkflowUrlEntryPointRecord {
  readonly kind: 'url';
  readonly url: string;
}

export type WorkflowTriggerRecord =
  | { readonly kind: 'manual' }
  | { readonly kind: 'schedule'; readonly schedule: WorkflowScheduleRecord };

export type WorkflowScheduleRecord =
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

export interface DurableWorkflowDefinitionRecord {
  readonly workflowId: string;
  readonly definitionRevision: number;
  readonly name: string;
  readonly objective: string;
  readonly entryPoint: WorkflowUrlEntryPointRecord;
  readonly trigger: WorkflowTriggerRecord;
  readonly enabled: boolean;
  readonly reviewRequired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowOccurrenceFrozenDefinitionRecord {
  readonly objective: string;
  readonly entryPoint: WorkflowUrlEntryPointRecord;
  readonly trigger: WorkflowTriggerRecord;
}

export interface WorkflowOccurrenceRecord {
  readonly occurrenceId: string;
  readonly workflowId: string;
  readonly definitionRevision: number;
  readonly triggerKey: string;
  readonly scheduledFor: string | null;
  readonly frozenDefinition: WorkflowOccurrenceFrozenDefinitionRecord;
  readonly state: WorkflowOccurrenceState;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly ownerRuntimeSessionId: string | null;
  readonly terminalReason: string | null;
  readonly finalAnswer: string | null;
}

export interface WorkflowStoreSnapshot {
  readonly schemaVersion: typeof WORKFLOW_STORE_SCHEMA_VERSION;
  readonly storeRevision: number;
  readonly workflows: readonly DurableWorkflowDefinitionRecord[];
  readonly occurrences: readonly WorkflowOccurrenceRecord[];
}

export interface WorkflowStorePayload {
  readonly workflows: readonly DurableWorkflowDefinitionRecord[];
  readonly occurrences: readonly WorkflowOccurrenceRecord[];
}

export type WorkflowStoreMutation = (current: WorkflowStoreSnapshot) => WorkflowStorePayload;

export const EMPTY_WORKFLOW_STORE_SNAPSHOT: WorkflowStoreSnapshot = Object.freeze({
  schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
  storeRevision: 0,
  workflows: Object.freeze([]),
  occurrences: Object.freeze([]),
});

export const FORBIDDEN_WORKFLOW_STORE_FIELD_NAMES = Object.freeze([
  'tabId',
  'taskId',
  'generation',
  'runId',
  'AgentRunRef',
  'targetId',
  'observationId',
  'documentRevision',
  'backendDOMNodeId',
  'frameId',
  'approvalId',
  'preparedActionId',
  'executionId',
  'InteractionGrant',
  'ExecuteGrant',
  'PreparedAction',
  'coordinates',
  'cookie',
  'password',
  'otp',
  'card',
] as const);

export const WORKFLOW_STORE_TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'storeRevision',
  'workflows',
  'occurrences',
] as const);

export const WORKFLOW_DEFINITION_KEYS = Object.freeze([
  'workflowId',
  'definitionRevision',
  'name',
  'objective',
  'entryPoint',
  'trigger',
  'enabled',
  'reviewRequired',
  'createdAt',
  'updatedAt',
] as const);

export const WORKFLOW_OCCURRENCE_KEYS = Object.freeze([
  'occurrenceId',
  'workflowId',
  'definitionRevision',
  'triggerKey',
  'scheduledFor',
  'frozenDefinition',
  'state',
  'createdAt',
  'startedAt',
  'finishedAt',
  'ownerRuntimeSessionId',
  'terminalReason',
  'finalAnswer',
] as const);
