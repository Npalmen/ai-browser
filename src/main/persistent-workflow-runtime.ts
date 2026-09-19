import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  AutonomousTaskControlResult,
  AutonomousTaskEvent,
  AutonomousTaskStartResult,
} from '../shared/autonomous-task-types';
import { DurableWorkflowCoordinator } from './durable-workflow-coordinator';
import {
  AutonomousTaskExecutionSlot,
  AutonomousTaskSlotReservation,
  slotBusyError,
} from './autonomous-task-execution-slot';
import { WorkflowOccurrenceRunner } from './workflow-occurrence-runner';
import { WorkflowScheduler } from './workflow-scheduler';
import { AtomicJsonWorkflowStore } from './workflow-store';
import type {
  CreateDurableWorkflowInput,
  DurableWorkflowId,
  EditDurableWorkflowInput,
  WorkflowOccurrenceId,
  WorkflowStorePort,
} from '../workflows/durable-workflow-types';
import type { DurableWorkflowDefinitionRecord, WorkflowOccurrenceRecord } from '../workflows/workflow-store-types';
import type { SchedulerTimerPort } from '../workflows/workflow-scheduler-types';
import type {
  WorkflowAutonomousTaskPort,
  WorkflowBrowserStartupPort,
  WorkflowOccurrenceDurablePort,
} from '../workflows/workflow-occurrence-runner-types';
import { isWorkflowStoreError } from '../workflows/workflow-store-errors';
import { aiSafeError } from './ai-safe-error';

export type PersistentWorkflowRuntimeStatus = 'ready' | 'storage-error' | 'not-initialized';

export interface WorkflowExecutionBinding {
  readonly browser: WorkflowBrowserStartupPort;
  readonly autonomousTasks: WorkflowExecutionTaskPort;
}

export interface WorkflowExecutionTaskPort extends WorkflowAutonomousTaskPort {
  start(objective: string): AutonomousTaskStartResult;
  resume(taskId: string): AutonomousTaskControlResult;
  pause(taskId: string): Promise<AutonomousTaskControlResult>;
  stop(taskId: string): Promise<AutonomousTaskControlResult>;
}

export interface PersistentWorkflowRuntimeOptions {
  readonly directory: string;
  readonly store?: WorkflowStorePort;
  readonly now?: () => Date;
  readonly timer?: SchedulerTimerPort;
  readonly runtimeSessionId?: string;
  readonly slot?: AutonomousTaskExecutionSlot;
}

const TERMINAL_TASK_EVENTS = new Set<AutonomousTaskEvent['type']>([
  'autonomous-task-completed',
  'autonomous-task-blocked',
  'autonomous-task-failed',
  'autonomous-task-cancelled',
  'autonomous-task-execution-state-unknown',
]);

/**
 * Process-level V7 lifecycle. Arbitrates the one V6 execution slot and wires
 * scheduler queue notifications to serialized FIFO drain. Does not click,
 * mint grants, or approve V4 actions.
 *
 * Chosen no-window policy: the scheduler may stay process-live and enqueue due
 * durable occurrences, but drain is disabled without an execution binding.
 */
export class PersistentWorkflowRuntime {
  readonly status: PersistentWorkflowRuntimeStatus;
  readonly runtimeSessionId: string | undefined;
  private readonly slot: AutonomousTaskExecutionSlot;
  private readonly coordinator: DurableWorkflowCoordinator | undefined;
  private scheduler: WorkflowScheduler | undefined;
  private runner: WorkflowOccurrenceRunner | undefined;
  private binding: WorkflowExecutionBinding | undefined;
  private workflowReservation: AutonomousTaskSlotReservation | undefined;
  private manualReservation: AutonomousTaskSlotReservation | undefined;
  private unsubscribeEvents: (() => void) | undefined;
  private drainTail = Promise.resolve();
  private eventTail = Promise.resolve();
  private detachTail = Promise.resolve();
  private shuttingDown = false;
  private disposed = false;
  private executionDisabled = false;
  private executionBindingGeneration = 0;
  private markRunningGate: (() => Promise<void>) | undefined;
  private terminalizeGate: (() => Promise<void>) | undefined;
  private readonly productStateListeners = new Set<() => void>();

  private constructor(input: {
    status: PersistentWorkflowRuntimeStatus;
    runtimeSessionId?: string;
    slot: AutonomousTaskExecutionSlot;
    coordinator?: DurableWorkflowCoordinator;
    scheduler?: WorkflowScheduler;
  }) {
    this.status = input.status;
    this.runtimeSessionId = input.runtimeSessionId;
    this.slot = input.slot;
    this.coordinator = input.coordinator;
    this.scheduler = input.scheduler;
  }

  static async initialize(options: PersistentWorkflowRuntimeOptions): Promise<PersistentWorkflowRuntime> {
    const slot = options.slot ?? new AutonomousTaskExecutionSlot();
    const store = options.store ?? new AtomicJsonWorkflowStore({ directory: options.directory });
    try {
      await store.load();
    } catch (error) {
      return PersistentWorkflowRuntime.containStartupStorageError(slot, error);
    }

    const runtimeSessionId = options.runtimeSessionId ?? randomUUID();
    const coordinator = new DurableWorkflowCoordinator({
      store,
      now: options.now,
    });
    try {
      await coordinator.initialize(runtimeSessionId);
    } catch (error) {
      return PersistentWorkflowRuntime.containStartupStorageError(slot, error);
    }

    const runtime = new PersistentWorkflowRuntime({
      status: 'ready',
      runtimeSessionId,
      slot,
      coordinator,
    });
    const scheduler = new WorkflowScheduler({
      coordinator,
      now: options.now,
      timer: options.timer,
      onQueueChanged: () => {
        runtime.requestDrain();
        runtime.notifyProductStateChanged();
      },
      onBackgroundError: () => {
        runtime.executionDisabled = true;
      },
    });
    runtime.scheduler = scheduler;
    try {
      await scheduler.start();
    } catch (error) {
      scheduler.dispose();
      runtime.scheduler = undefined;
      return PersistentWorkflowRuntime.containStartupStorageError(slot, error);
    }
    return runtime;
  }

  private static containStartupStorageError(
    slot: AutonomousTaskExecutionSlot,
    error: unknown,
  ): PersistentWorkflowRuntime {
    if (isWorkflowStoreError(error)) {
      return PersistentWorkflowRuntime.createStorageErrorRuntime(slot);
    }
    throw error;
  }

  private static createStorageErrorRuntime(slot: AutonomousTaskExecutionSlot): PersistentWorkflowRuntime {
    return new PersistentWorkflowRuntime({ status: 'storage-error', slot });
  }

  getSlotOwner() {
    return this.slot.owner();
  }

  getRunner(): WorkflowOccurrenceRunner | undefined {
    return this.runner;
  }

  setMarkRunningGate(gate: (() => Promise<void>) | undefined): void {
    this.markRunningGate = gate;
  }

  setTerminalizeGate(gate: (() => Promise<void>) | undefined): void {
    this.terminalizeGate = gate;
  }

  attachExecutionRuntime(
    binding: WorkflowExecutionBinding,
    subscribe?: (listener: (event: AutonomousTaskEvent) => void) => () => void,
  ): void {
    if (this.disposed || this.shuttingDown) {
      return;
    }
    this.executionBindingGeneration += 1;
    this.detachEventSubscription();
    this.binding = binding;
    if (subscribe) {
      this.unsubscribeEvents = subscribe((event) => {
        this.handleAutonomousTaskEvent(event);
      });
    }
    if (this.status !== 'ready' || this.coordinator === undefined || this.executionDisabled) {
      return;
    }
    if (this.runner?.getActiveOccurrence() !== undefined) {
      return;
    }
    this.runner = new WorkflowOccurrenceRunner({
      durable: this.createDurablePort(this.coordinator),
      browser: binding.browser,
      autonomousTasks: binding.autonomousTasks,
    });
    this.requestDrain();
  }

  detachExecutionRuntime(): void {
    this.executionBindingGeneration += 1;
    this.detachEventSubscription();
    this.releaseManualReservationOnDetach();
    this.binding = undefined;
    const detachedRunner = this.runner;
    if (detachedRunner === undefined) {
      return;
    }
    if (detachedRunner.getActiveOccurrence() === undefined) {
      this.runner = undefined;
      return;
    }
    this.detachTail = this.detachTail
      .then(() => this.finishDetach(detachedRunner))
      .catch(() => undefined);
  }

  handleAutonomousTaskEvent(event: AutonomousTaskEvent): void {
    this.eventTail = this.eventTail
      .then(() => this.dispatchTaskEvent(event))
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    for (let pass = 0; pass < 3; pass += 1) {
      await this.eventTail;
      await this.drainTail;
      await this.detachTail;
    }
  }

  startManualAutonomousTask(objective: string): AutonomousTaskStartResult {
    const tasks = this.binding?.autonomousTasks;
    if (!tasks) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    const reservation = this.slot.tryReserveManual();
    if (reservation === undefined) {
      return { ok: false, error: slotBusyError() };
    }
    const started = tasks.start(objective);
    if (!started.ok) {
      this.slot.release(reservation);
      return started;
    }
    this.manualReservation = reservation;
    this.slot.bindTaskId(reservation, started.task.taskId);
    return started;
  }

  resumeManualAutonomousTask(taskId: string): AutonomousTaskControlResult {
    const tasks = this.binding?.autonomousTasks;
    if (!tasks) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    const reservation = this.slot.tryReserveManual();
    if (reservation === undefined) {
      return { ok: false, error: slotBusyError() };
    }
    const resumed = tasks.resume(taskId);
    if (!resumed.ok) {
      this.slot.release(reservation);
      return resumed;
    }
    this.manualReservation = reservation;
    this.slot.bindTaskId(reservation, taskId);
    return resumed;
  }

  async pauseAutonomousTask(taskId: string): Promise<AutonomousTaskControlResult> {
    const tasks = this.binding?.autonomousTasks;
    if (!tasks) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    const paused = await tasks.pause(taskId);
    if (paused.ok) {
      this.releaseManualSlotIfOwned(taskId);
      this.requestDrain();
    }
    return paused;
  }

  async stopAutonomousTask(taskId: string): Promise<AutonomousTaskControlResult> {
    const tasks = this.binding?.autonomousTasks;
    if (!tasks) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    return tasks.stop(taskId);
  }

  async stopActiveWorkflowOccurrence(): Promise<AutonomousTaskControlResult | { ok: true }> {
    const runner = this.runner;
    if (runner === undefined) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    if (runner.hasPendingTerminal()) {
      await runner.reconcilePendingTerminal();
      this.releaseWorkflowSlotIfRunnerFree();
      this.requestDrain();
      this.notifyProductStateChanged();
      return { ok: true };
    }
    const live = runner.inspectLiveExecution();
    if (live !== undefined) {
      const tasks = this.binding?.autonomousTasks;
      if (tasks === undefined) {
        await runner.handleExecutionRuntimeUnavailable();
        this.releaseWorkflowSlotIfRunnerFree();
        this.notifyProductStateChanged();
        return { ok: true };
      }
      return tasks.stop(live.taskId);
    }
    if (runner.getActiveOccurrence() !== undefined) {
      await runner.reconcilePendingTerminal();
      this.releaseWorkflowSlotIfRunnerFree();
      this.requestDrain();
      this.notifyProductStateChanged();
      return { ok: true };
    }
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }

  async cancelQueuedOccurrence(occurrenceId: WorkflowOccurrenceId): Promise<WorkflowOccurrenceRecord> {
    const cancelled = await this.requireCoordinator().cancelQueuedOccurrence(occurrenceId);
    this.requestDrain();
    this.notifyProductStateChanged();
    return cancelled;
  }

  async notifyWorkflowStoreChanged(): Promise<void> {
    await this.scheduler?.notifyStoreChanged();
    this.requestDrain();
    this.notifyProductStateChanged();
  }

  async createWorkflow(input: CreateDurableWorkflowInput): Promise<DurableWorkflowDefinitionRecord> {
    const created = await this.requireCoordinator().createWorkflow(input);
    await this.notifyWorkflowStoreChanged();
    return created;
  }

  async editWorkflow(
    workflowId: DurableWorkflowId,
    input: EditDurableWorkflowInput,
  ): Promise<DurableWorkflowDefinitionRecord> {
    const edited = await this.requireCoordinator().editWorkflow(workflowId, input);
    await this.notifyWorkflowStoreChanged();
    return edited;
  }

  async setWorkflowEnabled(
    workflowId: DurableWorkflowId,
    enabled: boolean,
  ): Promise<DurableWorkflowDefinitionRecord> {
    const updated = await this.requireCoordinator().setEnabled(workflowId, enabled);
    await this.notifyWorkflowStoreChanged();
    return updated;
  }

  async runWorkflowNow(workflowId: DurableWorkflowId): Promise<WorkflowOccurrenceRecord> {
    const occurrence = await this.requireCoordinator().enqueueManualOccurrence(workflowId);
    await this.notifyWorkflowStoreChanged();
    return occurrence;
  }

  async acknowledgeWorkflowReview(workflowId: DurableWorkflowId): Promise<DurableWorkflowDefinitionRecord> {
    const acknowledged = await this.requireCoordinator().acknowledgeReview(workflowId);
    await this.notifyWorkflowStoreChanged();
    return acknowledged;
  }

  async deleteWorkflow(workflowId: DurableWorkflowId): Promise<void> {
    await this.requireCoordinator().deleteWorkflow(workflowId);
    await this.notifyWorkflowStoreChanged();
  }

  subscribeStateChanged(listener: () => void): () => void {
    this.productStateListeners.add(listener);
    return () => {
      this.productStateListeners.delete(listener);
    };
  }

  getCoordinator(): DurableWorkflowCoordinator | undefined {
    return this.coordinator;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    this.scheduler?.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.shuttingDown = true;
    this.detachEventSubscription();
    this.scheduler?.dispose();
    this.binding = undefined;
  }

  requestDrain(): void {
    if (this.disposed || this.shuttingDown || this.executionDisabled) {
      return;
    }
    this.drainTail = this.drainTail.then(() => this.drainOnce()).catch(() => undefined);
  }

  private createDurablePort(coordinator: DurableWorkflowCoordinator): WorkflowOccurrenceDurablePort {
    return {
      getOccurrence: (occurrenceId) => coordinator.getOccurrence(occurrenceId),
      markOccurrenceRunning: async (occurrenceId) => {
        if (this.markRunningGate) {
          await this.markRunningGate();
        }
        return coordinator.markOccurrenceRunning(occurrenceId);
      },
      terminalizeRunningOccurrence: async (input) => {
        if (this.terminalizeGate) {
          await this.terminalizeGate();
        }
        return coordinator.terminalizeRunningOccurrence(input);
      },
    };
  }

  private async drainOnce(): Promise<void> {
    const generation = this.executionBindingGeneration;
    const runner = this.runner;
    if (!this.canDrain() || runner === undefined) {
      return;
    }
    const coordinator = this.coordinator;
    if (coordinator === undefined) {
      return;
    }
    const queued = await coordinator.listQueuedOccurrences();
    if (!this.drainStillOwns(generation, runner)) {
      return;
    }
    const workflows = await coordinator.listWorkflows();
    if (!this.drainStillOwns(generation, runner)) {
      return;
    }
    const byId = new Map(workflows.map((workflow) => [workflow.workflowId, workflow]));
    // Finite bound: at most the queued rows observed for this drain epoch.
    const epochLimit = queued.length;
    let examined = 0;
    for (const occurrence of queued) {
      if (examined >= epochLimit || !this.drainStillOwns(generation, runner) || !this.slot.isFree()) {
        return;
      }
      examined += 1;
      const workflow = byId.get(occurrence.workflowId);
      if (workflow === undefined || !workflow.enabled || workflow.reviewRequired) {
        continue;
      }
      const reservation = this.slot.tryReserveWorkflow(occurrence.occurrenceId);
      if (reservation === undefined) {
        return;
      }
      this.workflowReservation = reservation;
      const result = await runner.startOccurrence(occurrence.occurrenceId);
      if (this.runner !== runner) {
        if (runner.getActiveOccurrence() !== undefined) {
          await runner.handleExecutionRuntimeUnavailable();
        }
        if (this.workflowReservation === reservation && runner.getActiveOccurrence() === undefined) {
          this.slot.release(reservation);
          this.workflowReservation = undefined;
        }
        return;
      }
      if (result.status === 'started') {
        const live = runner.inspectLiveExecution();
        if (live?.taskId) {
          this.slot.bindTaskId(reservation, live.taskId);
        }
        this.notifyProductStateChanged();
        return;
      }
      this.notifyProductStateChanged();
      if (runner.getActiveOccurrence()?.occurrenceId === occurrence.occurrenceId) {
        return;
      }
      this.slot.release(reservation);
      this.workflowReservation = undefined;
      if (result.status === 'busy') {
        return;
      }
    }
  }

  private drainStillOwns(generation: number, runner: WorkflowOccurrenceRunner): boolean {
    return (
      this.executionBindingGeneration === generation &&
      this.runner === runner &&
      this.canDrain()
    );
  }

  private canDrain(): boolean {
    return (
      !this.disposed &&
      !this.shuttingDown &&
      !this.executionDisabled &&
      this.status === 'ready' &&
      this.binding !== undefined &&
      this.runner !== undefined
    );
  }

  private async dispatchTaskEvent(event: AutonomousTaskEvent): Promise<void> {
    const runner = this.runner;
    const live = runner?.inspectLiveExecution();
    const active = runner?.getActiveOccurrence();
    if (runner !== undefined && live !== undefined && event.task.taskId === live.taskId) {
      await runner.handleAutonomousTaskEvent(event);
      this.notifyProductStateChanged();
      if (!this.disposed) {
        this.releaseWorkflowSlotIfRunnerFree();
        if (this.workflowReservation === undefined) {
          this.requestDrain();
        }
      }
      return;
    }
    if (active !== undefined && live === undefined) {
      return;
    }
    if (this.disposed) {
      return;
    }
    const owner = this.slot.owner();
    if (owner?.kind !== 'manual' || owner.taskId !== event.task.taskId) {
      return;
    }
    if (event.type === 'autonomous-task-paused' || TERMINAL_TASK_EVENTS.has(event.type)) {
      this.releaseManualSlotIfOwned(event.task.taskId);
      this.requestDrain();
    }
  }

  private releaseWorkflowSlotIfRunnerFree(): void {
    if (this.runner?.getActiveOccurrence() !== undefined) {
      return;
    }
    if (this.workflowReservation !== undefined) {
      this.slot.release(this.workflowReservation);
      this.workflowReservation = undefined;
    }
  }

  private releaseManualSlotIfOwned(taskId: string): void {
    const owner = this.slot.owner();
    if (owner?.kind !== 'manual' || owner.taskId !== taskId) {
      return;
    }
    if (this.manualReservation !== undefined) {
      this.slot.release(this.manualReservation);
      this.manualReservation = undefined;
    }
  }

  private releaseManualReservationOnDetach(): void {
    if (this.slot.owner()?.kind !== 'manual' || this.manualReservation === undefined) {
      return;
    }
    this.slot.release(this.manualReservation);
    this.manualReservation = undefined;
  }

  private requireCoordinator(): DurableWorkflowCoordinator {
    if (this.coordinator === undefined) {
      throw new Error('Workflow runtime is not ready.');
    }
    return this.coordinator;
  }

  private notifyProductStateChanged(): void {
    for (const listener of [...this.productStateListeners]) {
      try {
        listener();
      } catch {
        // Listener failure must not affect workflow authority.
      }
    }
  }

  private detachEventSubscription(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
  }

  private async finishDetach(detachedRunner: WorkflowOccurrenceRunner): Promise<void> {
    await detachedRunner.handleExecutionRuntimeUnavailable();
    this.notifyProductStateChanged();
    if (detachedRunner.getActiveOccurrence() !== undefined) {
      this.executionDisabled = true;
      return;
    }
    if (this.runner === detachedRunner) {
      this.releaseWorkflowSlotIfRunnerFree();
      this.runner = undefined;
    }
    if (
      this.binding === undefined ||
      this.status !== 'ready' ||
      this.coordinator === undefined ||
      this.executionDisabled ||
      this.disposed ||
      this.shuttingDown ||
      this.runner !== undefined
    ) {
      return;
    }
    this.runner = new WorkflowOccurrenceRunner({
      durable: this.createDurablePort(this.coordinator),
      browser: this.binding.browser,
      autonomousTasks: this.binding.autonomousTasks,
    });
    this.requestDrain();
  }
}

let processRuntime: PersistentWorkflowRuntime | null = null;

export function getPersistentWorkflowRuntime(): PersistentWorkflowRuntime | null {
  return processRuntime;
}

export async function initializePersistentWorkflowRuntime(
  options: PersistentWorkflowRuntimeOptions,
): Promise<PersistentWorkflowRuntime> {
  processRuntime?.dispose();
  processRuntime = await PersistentWorkflowRuntime.initialize(options);
  return processRuntime;
}

export function disposePersistentWorkflowRuntime(): void {
  processRuntime?.dispose();
  processRuntime = null;
}

export function productionWorkflowStoreDirectory(userDataPath: string): string {
  return path.resolve(userDataPath);
}
