import {
  createNodeSchedulerTimerPort,
  MAX_SCHEDULER_TIMER_DELAY_MS,
  MIN_SCHEDULER_TIMER_DELAY_MS,
  type SchedulerTimerHandle,
  type SchedulerTimerPort,
  type WorkflowSchedulerCoordinatorPort,
  type WorkflowSchedulerOptions,
} from '../workflows/workflow-scheduler-types';
import {
  evaluateWorkflowSchedule,
  isWorkflowScheduleError,
  scheduledTriggerKey,
} from '../workflows/workflow-schedule';

/**
 * Trusted due-time calculator. Owns scheduled occurrence identity and one
 * next-due timer hint. Does not start occurrences or own browser authority.
 */
export class WorkflowScheduler {
  private readonly coordinator: WorkflowSchedulerCoordinatorPort;
  private readonly now: () => Date;
  private readonly timer: SchedulerTimerPort;
  private started = false;
  private disposed = false;
  private timerGeneration = 0;
  private timerHandle: SchedulerTimerHandle | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: WorkflowSchedulerOptions) {
    this.coordinator = options.coordinator;
    this.now = options.now ?? (() => new Date());
    this.timer = options.timer ?? createNodeSchedulerTimerPort();
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error('Workflow scheduler is disposed.');
    }
    this.started = true;
    await this.recompute();
  }

  async notifyStoreChanged(): Promise<void> {
    return this.recompute();
  }

  async recompute(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const run = this.tail.then(() => this.recomputeOnce());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    this.invalidateTimer();
  }

  private async recomputeOnce(): Promise<void> {
    const generation = this.invalidateTimer();
    if (this.disposed) {
      return;
    }

    const now = this.now();
    const workflows = await this.coordinator.listWorkflows();
    if (this.disposed) {
      return;
    }

    let earliestFuture: string | null = null;
    for (const workflow of workflows) {
      if (this.disposed) {
        return;
      }
      if (workflow.trigger.kind !== 'schedule' || !workflow.enabled || workflow.reviewRequired) {
        continue;
      }

      let latestDue: string | null;
      let nextFuture: string | null;
      try {
        const evaluation = evaluateWorkflowSchedule(workflow.trigger, now);
        latestDue = evaluation.latestDue;
        nextFuture = evaluation.nextFuture;
      } catch (error) {
        if (isWorkflowScheduleError(error)) {
          await this.coordinator.markScheduleReviewRequired(workflow.workflowId);
          continue;
        }
        throw error;
      }

      if (latestDue !== null) {
        const triggerKey = scheduledTriggerKey(workflow.workflowId, latestDue);
        const existing = await this.coordinator.listOccurrences(workflow.workflowId);
        if (!existing.some((occurrence) => occurrence.triggerKey === triggerKey)) {
          await this.coordinator.enqueueScheduledOccurrence({
            workflowId: workflow.workflowId,
            scheduledFor: latestDue,
          });
        }
      }

      if (nextFuture !== null && (earliestFuture === null || nextFuture < earliestFuture)) {
        earliestFuture = nextFuture;
      }
    }

    if (this.disposed || this.timerGeneration !== generation) {
      return;
    }
    this.armTimer(generation, now, earliestFuture);
  }

  private armTimer(generation: number, now: Date, earliestFuture: string | null): void {
    if (this.disposed || this.timerGeneration !== generation || earliestFuture === null) {
      return;
    }
    const dueMs = Date.parse(earliestFuture);
    if (!Number.isFinite(dueMs)) {
      return;
    }
    let delayMs = dueMs - now.getTime();
    if (delayMs <= 0) {
      delayMs = MIN_SCHEDULER_TIMER_DELAY_MS;
    } else if (delayMs > MAX_SCHEDULER_TIMER_DELAY_MS) {
      delayMs = MAX_SCHEDULER_TIMER_DELAY_MS;
    }
    this.timerHandle = this.timer.setTimer(delayMs, () => {
      if (this.disposed || this.timerGeneration !== generation) {
        return;
      }
      return this.recompute();
    });
  }

  private invalidateTimer(): number {
    this.timerGeneration += 1;
    if (this.timerHandle !== undefined) {
      this.timer.clearTimer(this.timerHandle);
      this.timerHandle = undefined;
    }
    return this.timerGeneration;
  }
}
