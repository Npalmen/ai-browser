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

type SchedulerLifecycle = 'stopped' | 'starting' | 'started' | 'disposed';

/**
 * Trusted due-time calculator. Owns scheduled occurrence identity and one
 * next-due timer hint. Does not start occurrences or own browser authority.
 *
 * Constructed ≠ active. Only a successful `start()` may evaluate schedules.
 */
export class WorkflowScheduler {
  private readonly coordinator: WorkflowSchedulerCoordinatorPort;
  private readonly now: () => Date;
  private readonly timer: SchedulerTimerPort;
  private readonly onBackgroundError: ((error: unknown) => void) | undefined;
  private readonly onQueueChanged: (() => void) | undefined;
  private lifecycle: SchedulerLifecycle = 'stopped';
  private startPromise: Promise<void> | undefined;
  private timerGeneration = 0;
  private timerHandle: SchedulerTimerHandle | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: WorkflowSchedulerOptions) {
    this.coordinator = options.coordinator;
    this.now = options.now ?? (() => new Date());
    this.timer = options.timer ?? createNodeSchedulerTimerPort();
    this.onBackgroundError = options.onBackgroundError;
    this.onQueueChanged = options.onQueueChanged;
  }

  async start(): Promise<void> {
    if (this.lifecycle === 'disposed') {
      throw new Error('Workflow scheduler is disposed.');
    }
    if (this.lifecycle === 'started') {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.lifecycle = 'starting';
    const attempt = this.activate();
    this.startPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.startPromise === attempt) {
        this.startPromise = undefined;
      }
    }
  }

  async notifyStoreChanged(): Promise<void> {
    return this.recompute();
  }

  async recompute(): Promise<void> {
    if (this.lifecycle !== 'started') {
      return;
    }
    return this.queueCycle('active');
  }

  dispose(): void {
    this.lifecycle = 'disposed';
    this.invalidateTimer();
  }

  private async activate(): Promise<void> {
    try {
      await this.queueCycle('start');
      if (this.lifecycle !== 'started') {
        throw new Error('Workflow scheduler is disposed.');
      }
    } catch (error) {
      if (this.lifecycle === 'starting') {
        this.lifecycle = 'stopped';
        this.invalidateTimer();
      }
      throw error;
    }
  }

  private queueCycle(mode: 'start' | 'active'): Promise<void> {
    const run = this.tail.then(() => this.recomputeOnce(mode));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async recomputeOnce(mode: 'start' | 'active'): Promise<void> {
    const generation = this.invalidateTimer();
    if (!this.canEvaluate(mode)) {
      return;
    }

    const now = this.now();
    const workflows = await this.coordinator.listWorkflows();
    if (!this.canEvaluate(mode)) {
      return;
    }

    let earliestFuture: string | null = null;
    for (const workflow of workflows) {
      if (!this.canEvaluate(mode)) {
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
          if (!this.canEvaluate(mode)) {
            return;
          }
          await this.coordinator.markScheduleReviewRequired(workflow.workflowId);
          continue;
        }
        throw error;
      }

      if (latestDue !== null) {
        if (!this.canEvaluate(mode)) {
          return;
        }
        const triggerKey = scheduledTriggerKey(workflow.workflowId, latestDue);
        const existing = await this.coordinator.listOccurrences(workflow.workflowId);
        if (!this.canEvaluate(mode)) {
          return;
        }
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

    if (!this.canEvaluate(mode) || this.timerGeneration !== generation) {
      return;
    }
    if (mode === 'start') {
      this.lifecycle = 'started';
    }
    if (this.lifecycle !== 'started') {
      return;
    }
    this.armTimer(generation, now, earliestFuture);
    this.notifyQueueChanged();
  }

  private notifyQueueChanged(): void {
    if (this.lifecycle !== 'started') {
      return;
    }
    try {
      this.onQueueChanged?.();
    } catch {
      // Queue listeners must not break due-time evaluation.
    }
  }

  private canEvaluate(mode: 'start' | 'active'): boolean {
    if (this.lifecycle === 'disposed') {
      return false;
    }
    if (mode === 'start') {
      return this.lifecycle === 'starting';
    }
    return this.lifecycle === 'started';
  }

  private armTimer(generation: number, now: Date, earliestFuture: string | null): void {
    if (this.lifecycle !== 'started' || this.timerGeneration !== generation || earliestFuture === null) {
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
      if (this.lifecycle !== 'started' || this.timerGeneration !== generation) {
        return;
      }
      return this.recompute().catch((error) => {
        this.reportBackgroundError(error);
      });
    });
  }

  private reportBackgroundError(error: unknown): void {
    try {
      this.onBackgroundError?.(error);
    } catch {
      // Diagnostic failures must not escape a timer callback.
    }
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
