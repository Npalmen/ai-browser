import type {
  DurableWorkflowDefinitionRecord,
  WorkflowOccurrenceRecord,
} from './workflow-store-types';

/** Node's reliable signed 32-bit timeout ceiling (2^31 - 1 ms). Farther dues recompute via chunks. */
export const MAX_SCHEDULER_TIMER_DELAY_MS = 2_147_483_647;
/** Minimum wake-up delay so a due-or-past nextFuture cannot busy-spin synchronously. */
export const MIN_SCHEDULER_TIMER_DELAY_MS = 1;

export type SchedulerTimerHandle = unknown;

export interface SchedulerTimerPort {
  setTimer(delayMs: number, callback: () => void | Promise<void>): SchedulerTimerHandle;
  clearTimer(handle: SchedulerTimerHandle): void;
}

export interface EnqueueScheduledOccurrencePortInput {
  readonly workflowId: string;
  readonly scheduledFor: string;
}

export interface WorkflowSchedulerCoordinatorPort {
  listWorkflows(): Promise<readonly DurableWorkflowDefinitionRecord[]>;
  listOccurrences(workflowId: string): Promise<readonly WorkflowOccurrenceRecord[]>;
  enqueueScheduledOccurrence(
    input: EnqueueScheduledOccurrencePortInput,
  ): Promise<WorkflowOccurrenceRecord>;
  markScheduleReviewRequired(workflowId: string): Promise<unknown>;
}

export interface WorkflowSchedulerOptions {
  readonly coordinator: WorkflowSchedulerCoordinatorPort;
  readonly now?: () => Date;
  readonly timer?: SchedulerTimerPort;
  /** Timer-driven failures only. Must not throw; the scheduler wraps it if it does. */
  readonly onBackgroundError?: (error: unknown) => void;
}

export function createNodeSchedulerTimerPort(): SchedulerTimerPort {
  return {
    setTimer(delayMs, callback) {
      return setTimeout(() => {
        void callback();
      }, delayMs);
    },
    clearTimer(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}
