import type { TabId } from '../shared/browser-types';
import type { AutonomousTaskEvent, AutonomousTaskStartResult } from '../shared/autonomous-task-types';
import type {
  TerminalizeRunningOccurrenceInput,
  WorkflowOccurrenceId,
} from './durable-workflow-types';
import type { WorkflowOccurrenceRecord } from './workflow-store-types';

export const WORKFLOW_START_REASON = Object.freeze({
  TAB: 'WORKFLOW_TAB_START_FAILED',
  V6: 'WORKFLOW_V6_START_FAILED',
  RESULT_MISSING: 'WORKFLOW_RESULT_MISSING',
});

export type WorkflowStartReason =
  (typeof WORKFLOW_START_REASON)[keyof typeof WORKFLOW_START_REASON];

export interface WorkflowBrowserStartupPort {
  createTab(input: { url: string; activate: false }): Promise<TabId>;
  closeTab(tabId: TabId): Promise<void>;
}

export interface WorkflowAutonomousTaskPort {
  hasActiveTask(): boolean;
  startOnTrustedTab(tabId: TabId, objective: string): AutonomousTaskStartResult;
}

export interface WorkflowOccurrenceDurablePort {
  getOccurrence(occurrenceId: WorkflowOccurrenceId): Promise<WorkflowOccurrenceRecord | undefined>;
  markOccurrenceRunning(occurrenceId: WorkflowOccurrenceId): Promise<WorkflowOccurrenceRecord>;
  terminalizeRunningOccurrence(
    input: TerminalizeRunningOccurrenceInput,
  ): Promise<WorkflowOccurrenceRecord>;
}

export interface WorkflowOccurrenceRunnerDependencies {
  readonly durable: WorkflowOccurrenceDurablePort;
  readonly browser: WorkflowBrowserStartupPort;
  readonly autonomousTasks: WorkflowAutonomousTaskPort;
}

export type WorkflowOccurrenceStartResult =
  | {
      readonly status: 'started';
      readonly occurrenceId: string;
    }
  | {
      readonly status: 'busy';
    }
  | {
      readonly status: 'failed';
      readonly occurrenceId: string;
    };

export interface WorkflowActiveOccurrence {
  readonly occurrenceId: string;
  readonly workflowId: string;
}

export interface WorkflowLiveExecutionInspection {
  readonly occurrenceId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly tabId: TabId;
}

export type WorkflowOccurrenceTaskEvent = AutonomousTaskEvent;

export function isTrustedWorkflowExecutionUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}
