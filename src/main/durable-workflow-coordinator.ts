import { randomUUID } from 'node:crypto';

import { DurableWorkflowError } from '../workflows/durable-workflow-errors';
import { pruneWorkflowOccurrenceHistory } from '../workflows/durable-workflow-history';
import {
  MAX_WORKFLOW_ID_REGENERATIONS,
  MAX_WORKFLOW_TRANSACTION_RETRIES,
  WORKFLOW_TERMINAL_REASON,
  type CreateDurableWorkflowInput,
  type DurableWorkflowCoordinatorOptions,
  type DurableWorkflowId,
  type EditDurableWorkflowInput,
  type EnqueueWorkflowOccurrenceInput,
  type RunningOccurrenceTerminalState,
  type TerminalizeRunningOccurrenceInput,
  type WorkflowEnqueueSource,
  type WorkflowOccurrenceId,
  type WorkflowStorePort,
} from '../workflows/durable-workflow-types';
import { isWorkflowStoreError } from '../workflows/workflow-store-errors';
import {
  MAX_OCCURRENCE_ID_CHARS,
  MAX_RUNTIME_SESSION_ID_CHARS,
  MAX_TERMINAL_REASON_CHARS,
  MAX_TRIGGER_KEY_CHARS,
  MAX_WORKFLOW_FINAL_ANSWER_CHARS,
  MAX_WORKFLOW_ID_CHARS,
  type DurableWorkflowDefinitionRecord,
  type WorkflowOccurrenceRecord,
  type WorkflowStorePayload,
  type WorkflowStoreSnapshot,
  type WorkflowTriggerRecord,
  type WorkflowUrlEntryPointRecord,
} from '../workflows/workflow-store-types';

const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type TransactionDecision<T> =
  | { readonly kind: 'return'; readonly value: T }
  | {
      readonly kind: 'write';
      readonly payload: WorkflowStorePayload;
      readonly pick: (next: WorkflowStoreSnapshot) => T;
    };

/**
 * Trusted-main durable workflow core.
 *
 * Owns definitions, occurrence state, FIFO queue, review flags, and restart
 * recovery. Does not own browser authority and does not stop live V6 tasks.
 *
 * `terminalizeRunningOccurrence` records durable truth after a live run has
 * already settled. It is not a product Stop/cancel of in-flight execution.
 */
export class DurableWorkflowCoordinator {
  private readonly store: WorkflowStorePort;
  private readonly now: () => Date;
  private readonly newWorkflowId: () => string;
  private readonly newOccurrenceId: () => string;
  private runtimeSessionId: string | undefined;

  constructor(options: DurableWorkflowCoordinatorOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newWorkflowId = options.newWorkflowId ?? randomUUID;
    this.newOccurrenceId = options.newOccurrenceId ?? randomUUID;
  }

  async initialize(runtimeSessionId: string): Promise<WorkflowStoreSnapshot> {
    const candidate = requireRuntimeSessionId(runtimeSessionId);
    if (this.runtimeSessionId !== undefined) {
      if (this.runtimeSessionId !== candidate) {
        throw new DurableWorkflowError(
          'WORKFLOW_ALREADY_INITIALIZED',
          'Workflow coordinator is already initialized.',
        );
      }
      return this.initializeForSession(candidate);
    }

    const snapshot = await this.initializeForSession(candidate);
    this.runtimeSessionId = candidate;
    return snapshot;
  }

  private async initializeForSession(candidate: string): Promise<WorkflowStoreSnapshot> {
    return this.transact((snapshot) => {
      const currentSessionRuns = snapshot.occurrences.filter(
        (occurrence) =>
          occurrence.state === 'running' && occurrence.ownerRuntimeSessionId === candidate,
      );
      if (currentSessionRuns.length > 1) {
        throw new DurableWorkflowError(
          'WORKFLOW_OCCURRENCE_INVALID_STATE',
          'Multiple running occurrences exist for this runtime session.',
        );
      }

      const stale = snapshot.occurrences.filter(
        (occurrence) =>
          occurrence.state === 'running' && occurrence.ownerRuntimeSessionId !== candidate,
      );
      if (stale.length === 0) {
        return { kind: 'return', value: snapshot };
      }

      const finishedAt = this.nowIso();
      const staleWorkflowIds = new Set(stale.map((occurrence) => occurrence.workflowId));
      const workflows = snapshot.workflows.map((workflow) =>
        staleWorkflowIds.has(workflow.workflowId)
          ? { ...workflow, reviewRequired: true, updatedAt: finishedAt }
          : workflow,
      );
      const occurrences = pruneWorkflowOccurrenceHistory(
        workflows,
        snapshot.occurrences.map((occurrence) =>
          stale.some((item) => item.occurrenceId === occurrence.occurrenceId)
            ? interruptOccurrence(occurrence, finishedAt)
            : occurrence,
        ),
      );
      return {
        kind: 'write',
        payload: { workflows, occurrences },
        pick: (next) => next,
      };
    }, { requireInitialized: false });
  }

  async createWorkflow(input: CreateDurableWorkflowInput): Promise<DurableWorkflowDefinitionRecord> {
    let workflowId = requireGeneratedId(this.newWorkflowId(), MAX_WORKFLOW_ID_CHARS, 'workflowId');
    let regenerations = 0;
    return this.transact((snapshot) => {
      while (snapshot.workflows.some((workflow) => workflow.workflowId === workflowId)) {
        regenerations += 1;
        if (regenerations > MAX_WORKFLOW_ID_REGENERATIONS) {
          throw new DurableWorkflowError(
            'WORKFLOW_CONCURRENT_MODIFICATION',
            'Could not allocate a unique workflow id.',
          );
        }
        workflowId = requireGeneratedId(this.newWorkflowId(), MAX_WORKFLOW_ID_CHARS, 'workflowId');
      }
      const timestamp = this.nowIso();
      const record: DurableWorkflowDefinitionRecord = {
        workflowId,
        definitionRevision: 1,
        name: input.name,
        objective: input.objective,
        entryPoint: cloneEntryPoint(input.entryPoint),
        trigger: cloneTrigger(input.trigger),
        enabled: input.enabled ?? true,
        reviewRequired: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return {
        kind: 'write',
        payload: {
          workflows: [...snapshot.workflows, record],
          occurrences: [...snapshot.occurrences],
        },
        pick: (next) => requireWorkflow(next, workflowId),
      };
    });
  }

  async editWorkflow(
    workflowId: DurableWorkflowId,
    input: EditDurableWorkflowInput,
  ): Promise<DurableWorkflowDefinitionRecord> {
    return this.transact((snapshot) => {
      const current = requireWorkflow(snapshot, workflowId);
      if (
        current.name === input.name &&
        current.objective === input.objective &&
        sameEntryPoint(current.entryPoint, input.entryPoint) &&
        sameTrigger(current.trigger, input.trigger)
      ) {
        return { kind: 'return', value: current };
      }
      const updated: DurableWorkflowDefinitionRecord = {
        ...current,
        name: input.name,
        objective: input.objective,
        entryPoint: cloneEntryPoint(input.entryPoint),
        trigger: cloneTrigger(input.trigger),
        definitionRevision: current.definitionRevision + 1,
        updatedAt: this.nowIso(),
      };
      return {
        kind: 'write',
        payload: {
          workflows: replaceWorkflow(snapshot.workflows, updated),
          occurrences: [...snapshot.occurrences],
        },
        pick: (next) => requireWorkflow(next, workflowId),
      };
    });
  }

  async setEnabled(workflowId: DurableWorkflowId, enabled: boolean): Promise<DurableWorkflowDefinitionRecord> {
    if (typeof enabled !== 'boolean') {
      throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'enabled must be a boolean.');
    }
    return this.transact((snapshot) => {
      const current = requireWorkflow(snapshot, workflowId);
      if (current.enabled === enabled) {
        return { kind: 'return', value: current };
      }
      const updated: DurableWorkflowDefinitionRecord = {
        ...current,
        enabled,
        updatedAt: this.nowIso(),
      };
      return {
        kind: 'write',
        payload: {
          workflows: replaceWorkflow(snapshot.workflows, updated),
          occurrences: [...snapshot.occurrences],
        },
        pick: (next) => requireWorkflow(next, workflowId),
      };
    });
  }

  async enqueueOccurrence(input: EnqueueWorkflowOccurrenceInput): Promise<WorkflowOccurrenceRecord> {
    const triggerKey = requireBoundedToken(input.triggerKey, MAX_TRIGGER_KEY_CHARS, 'triggerKey');
    const scheduledFor = requireNullableUtcInstant(input.scheduledFor);
    const source = requireEnqueueSource(input.source);
    const occurrenceId = requireGeneratedId(this.newOccurrenceId(), MAX_OCCURRENCE_ID_CHARS, 'occurrenceId');

    return this.transact((snapshot) => {
      const existing = snapshot.occurrences.find((occurrence) => occurrence.triggerKey === triggerKey);
      if (existing) {
        return { kind: 'return', value: existing };
      }
      const workflow = requireWorkflow(snapshot, input.workflowId);
      assertEnqueueEligible(workflow, source);
      const createdAt = this.nowIso();
      const record: WorkflowOccurrenceRecord = {
        occurrenceId,
        workflowId: workflow.workflowId,
        definitionRevision: workflow.definitionRevision,
        triggerKey,
        scheduledFor,
        frozenDefinition: {
          objective: workflow.objective,
          entryPoint: cloneEntryPoint(workflow.entryPoint),
          trigger: cloneTrigger(workflow.trigger),
        },
        state: 'queued',
        createdAt,
        startedAt: null,
        finishedAt: null,
        ownerRuntimeSessionId: null,
        terminalReason: null,
        finalAnswer: null,
      };
      const occurrences = pruneWorkflowOccurrenceHistory(snapshot.workflows, [...snapshot.occurrences, record]);
      return {
        kind: 'write',
        payload: {
          workflows: [...snapshot.workflows],
          occurrences,
        },
        pick: (next) => requireOccurrence(next, occurrenceId),
      };
    });
  }

  async markOccurrenceRunning(occurrenceId: WorkflowOccurrenceId): Promise<WorkflowOccurrenceRecord> {
    const sessionId = this.requireRuntimeSessionId();
    return this.transact((snapshot) => {
      const occurrence = requireOccurrence(snapshot, occurrenceId);
      if (occurrence.state !== 'queued') {
        throw new DurableWorkflowError(
          'WORKFLOW_OCCURRENCE_INVALID_STATE',
          'Only a queued occurrence can start running.',
        );
      }
      const workflow = requireWorkflow(snapshot, occurrence.workflowId);
      if (!workflow.enabled) {
        throw new DurableWorkflowError('WORKFLOW_DISABLED', 'Workflow is disabled.');
      }
      if (workflow.reviewRequired) {
        throw new DurableWorkflowError('WORKFLOW_REVIEW_REQUIRED', 'Workflow requires review.');
      }
      const running = snapshot.occurrences.filter((item) => item.state === 'running');
      if (running.length > 1) {
        throw new DurableWorkflowError(
          'WORKFLOW_OCCURRENCE_INVALID_STATE',
          'Multiple running occurrences exist.',
        );
      }
      if (running.length === 1) {
        throw new DurableWorkflowError('WORKFLOW_BUSY', 'Another workflow occurrence is already running.');
      }
      const startedAt = this.nowIso();
      const nextOccurrence: WorkflowOccurrenceRecord = {
        ...occurrence,
        state: 'running',
        startedAt,
        finishedAt: null,
        ownerRuntimeSessionId: sessionId,
        terminalReason: null,
        finalAnswer: null,
      };
      return {
        kind: 'write',
        payload: {
          workflows: [...snapshot.workflows],
          occurrences: replaceOccurrence(snapshot.occurrences, nextOccurrence),
        },
        pick: (next) => requireOccurrence(next, occurrenceId),
      };
    });
  }

  /**
   * Records a terminal durable result for a running occurrence.
   * Does not cancel or stop a live V6 AutonomousTask. Phase 4/5 must call this
   * only after live execution truth has settled.
   */
  async terminalizeRunningOccurrence(
    input: TerminalizeRunningOccurrenceInput,
  ): Promise<WorkflowOccurrenceRecord> {
    const state = requireRunningTerminalState(input.state);
    const terminalReason = resolveTerminalReason(state, input.terminalReason);
    const finalAnswer = resolveFinalAnswer(state, input.finalAnswer);
    return this.transact((snapshot) => {
      const occurrence = requireOccurrence(snapshot, input.occurrenceId);
      if (occurrence.state !== 'running') {
        throw new DurableWorkflowError(
          'WORKFLOW_OCCURRENCE_INVALID_STATE',
          'Only a running occurrence can be terminalized.',
        );
      }
      const finishedAt = this.nowIso();
      const nextOccurrence: WorkflowOccurrenceRecord = {
        ...occurrence,
        state,
        finishedAt,
        ownerRuntimeSessionId: null,
        terminalReason,
        finalAnswer,
      };
      let workflows = snapshot.workflows;
      if (state === 'execution-state-unknown') {
        const workflow = requireWorkflow(snapshot, occurrence.workflowId);
        workflows = replaceWorkflow(snapshot.workflows, {
          ...workflow,
          reviewRequired: true,
          updatedAt: finishedAt,
        });
      }
      return {
        kind: 'write',
        payload: {
          workflows,
          occurrences: pruneWorkflowOccurrenceHistory(
            workflows,
            replaceOccurrence(snapshot.occurrences, nextOccurrence),
          ),
        },
        pick: (next) => requireOccurrence(next, input.occurrenceId),
      };
    });
  }

  async cancelQueuedOccurrence(occurrenceId: WorkflowOccurrenceId): Promise<WorkflowOccurrenceRecord> {
    return this.transact((snapshot) => {
      const occurrence = requireOccurrence(snapshot, occurrenceId);
      if (occurrence.state !== 'queued') {
        throw new DurableWorkflowError(
          'WORKFLOW_OCCURRENCE_INVALID_STATE',
          'Only a queued occurrence can be cancelled.',
        );
      }
      const finishedAt = this.nowIso();
      const nextOccurrence: WorkflowOccurrenceRecord = {
        ...occurrence,
        state: 'cancelled',
        finishedAt,
        ownerRuntimeSessionId: null,
        terminalReason: WORKFLOW_TERMINAL_REASON.USER_CANCELLED,
        finalAnswer: null,
      };
      return {
        kind: 'write',
        payload: {
          workflows: [...snapshot.workflows],
          occurrences: pruneWorkflowOccurrenceHistory(
            snapshot.workflows,
            replaceOccurrence(snapshot.occurrences, nextOccurrence),
          ),
        },
        pick: (next) => requireOccurrence(next, occurrenceId),
      };
    });
  }

  async acknowledgeReview(workflowId: DurableWorkflowId): Promise<DurableWorkflowDefinitionRecord> {
    return this.transact((snapshot) => {
      const workflow = requireWorkflow(snapshot, workflowId);
      if (!workflow.reviewRequired) {
        return { kind: 'return', value: workflow };
      }
      if (
        snapshot.occurrences.some(
          (occurrence) => occurrence.workflowId === workflowId && occurrence.state === 'running',
        )
      ) {
        throw new DurableWorkflowError('WORKFLOW_RUNNING', 'Cannot acknowledge review while an occurrence is running.');
      }
      const updated: DurableWorkflowDefinitionRecord = {
        ...workflow,
        reviewRequired: false,
        updatedAt: this.nowIso(),
      };
      return {
        kind: 'write',
        payload: {
          workflows: replaceWorkflow(snapshot.workflows, updated),
          occurrences: pruneWorkflowOccurrenceHistory(
            replaceWorkflow(snapshot.workflows, updated),
            [...snapshot.occurrences],
          ),
        },
        pick: (next) => requireWorkflow(next, workflowId),
      };
    });
  }

  async deleteWorkflow(workflowId: DurableWorkflowId): Promise<void> {
    await this.transact((snapshot) => {
      requireWorkflow(snapshot, workflowId);
      if (
        snapshot.occurrences.some(
          (occurrence) => occurrence.workflowId === workflowId && occurrence.state === 'running',
        )
      ) {
        throw new DurableWorkflowError('WORKFLOW_RUNNING', 'Cannot delete a workflow with a running occurrence.');
      }
      return {
        kind: 'write',
        payload: {
          workflows: snapshot.workflows.filter((workflow) => workflow.workflowId !== workflowId),
          occurrences: snapshot.occurrences.filter((occurrence) => occurrence.workflowId !== workflowId),
        },
        pick: () => undefined,
      };
    });
  }

  async listWorkflows(): Promise<readonly DurableWorkflowDefinitionRecord[]> {
    this.requireRuntimeSessionId();
    return (await this.store.load()).workflows;
  }

  async getWorkflow(workflowId: DurableWorkflowId): Promise<DurableWorkflowDefinitionRecord | undefined> {
    this.requireRuntimeSessionId();
    return (await this.store.load()).workflows.find((workflow) => workflow.workflowId === workflowId);
  }

  async listOccurrences(workflowId: DurableWorkflowId): Promise<readonly WorkflowOccurrenceRecord[]> {
    this.requireRuntimeSessionId();
    return (await this.store.load()).occurrences.filter((occurrence) => occurrence.workflowId === workflowId);
  }

  async getOccurrence(occurrenceId: WorkflowOccurrenceId): Promise<WorkflowOccurrenceRecord | undefined> {
    this.requireRuntimeSessionId();
    return (await this.store.load()).occurrences.find((occurrence) => occurrence.occurrenceId === occurrenceId);
  }

  async listQueuedOccurrences(): Promise<readonly WorkflowOccurrenceRecord[]> {
    this.requireRuntimeSessionId();
    const queued = (await this.store.load()).occurrences.filter((occurrence) => occurrence.state === 'queued');
    return [...queued].sort(compareQueuedFifo);
  }

  async getRunningOccurrence(): Promise<WorkflowOccurrenceRecord | undefined> {
    this.requireRuntimeSessionId();
    const running = (await this.store.load()).occurrences.filter((occurrence) => occurrence.state === 'running');
    if (running.length > 1) {
      throw new DurableWorkflowError(
        'WORKFLOW_OCCURRENCE_INVALID_STATE',
        'Multiple running occurrences exist.',
      );
    }
    return running[0];
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private requireRuntimeSessionId(): string {
    if (this.runtimeSessionId === undefined) {
      throw new DurableWorkflowError('WORKFLOW_NOT_INITIALIZED', 'Workflow coordinator is not initialized.');
    }
    return this.runtimeSessionId;
  }

  private async transact<T>(
    operate: (snapshot: WorkflowStoreSnapshot) => TransactionDecision<T>,
    options: { requireInitialized?: boolean } = {},
  ): Promise<T> {
    if (options.requireInitialized !== false) {
      this.requireRuntimeSessionId();
    }
    for (let attempt = 0; attempt < MAX_WORKFLOW_TRANSACTION_RETRIES; attempt++) {
      const snapshot = await this.store.load();
      const decision = operate(snapshot);
      if (decision.kind === 'return') {
        return decision.value;
      }
      try {
        const next = await this.store.commit(snapshot.storeRevision, () => decision.payload);
        return decision.pick(next);
      } catch (error) {
        if (isWorkflowStoreError(error) && error.code === 'WORKFLOW_STORE_REVISION_CONFLICT') {
          continue;
        }
        if (isWorkflowStoreError(error) && error.code === 'WORKFLOW_STORE_MUTATION_INVALID') {
          throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'Workflow request is invalid.', {
            cause: error,
          });
        }
        throw error;
      }
    }
    throw new DurableWorkflowError(
      'WORKFLOW_CONCURRENT_MODIFICATION',
      'Workflow store was concurrently modified.',
    );
  }
}

function interruptOccurrence(
  occurrence: WorkflowOccurrenceRecord,
  finishedAt: string,
): WorkflowOccurrenceRecord {
  return {
    ...occurrence,
    state: 'interrupted',
    finishedAt,
    ownerRuntimeSessionId: null,
    terminalReason: WORKFLOW_TERMINAL_REASON.INTERRUPTED,
    finalAnswer: null,
  };
}

function assertEnqueueEligible(
  workflow: DurableWorkflowDefinitionRecord,
  _source: WorkflowEnqueueSource,
): void {
  if (!workflow.enabled) {
    throw new DurableWorkflowError('WORKFLOW_DISABLED', 'Workflow is disabled.');
  }
  if (workflow.reviewRequired) {
    throw new DurableWorkflowError('WORKFLOW_REVIEW_REQUIRED', 'Workflow requires review.');
  }
}

function requireWorkflow(
  snapshot: WorkflowStoreSnapshot,
  workflowId: string,
): DurableWorkflowDefinitionRecord {
  const workflow = snapshot.workflows.find((item) => item.workflowId === workflowId);
  if (!workflow) {
    throw new DurableWorkflowError('WORKFLOW_NOT_FOUND', 'Workflow was not found.');
  }
  return workflow;
}

function requireOccurrence(
  snapshot: WorkflowStoreSnapshot,
  occurrenceId: string,
): WorkflowOccurrenceRecord {
  const occurrence = snapshot.occurrences.find((item) => item.occurrenceId === occurrenceId);
  if (!occurrence) {
    throw new DurableWorkflowError('WORKFLOW_OCCURRENCE_NOT_FOUND', 'Workflow occurrence was not found.');
  }
  return occurrence;
}

function replaceWorkflow(
  workflows: readonly DurableWorkflowDefinitionRecord[],
  updated: DurableWorkflowDefinitionRecord,
): DurableWorkflowDefinitionRecord[] {
  return workflows.map((workflow) => (workflow.workflowId === updated.workflowId ? updated : workflow));
}

function replaceOccurrence(
  occurrences: readonly WorkflowOccurrenceRecord[],
  updated: WorkflowOccurrenceRecord,
): WorkflowOccurrenceRecord[] {
  return occurrences.map((occurrence) =>
    occurrence.occurrenceId === updated.occurrenceId ? updated : occurrence,
  );
}

function compareQueuedFifo(left: WorkflowOccurrenceRecord, right: WorkflowOccurrenceRecord): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.occurrenceId === right.occurrenceId) {
    return 0;
  }
  return left.occurrenceId < right.occurrenceId ? -1 : 1;
}

function cloneEntryPoint(entryPoint: WorkflowUrlEntryPointRecord): WorkflowUrlEntryPointRecord {
  return { kind: 'url', url: entryPoint.url };
}

function cloneTrigger(trigger: WorkflowTriggerRecord): WorkflowTriggerRecord {
  if (trigger.kind === 'manual') {
    return { kind: 'manual' };
  }
  if (trigger.schedule.kind === 'one-time') {
    return { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: trigger.schedule.runAtUtc } };
  }
  if (trigger.schedule.kind === 'recurring-daily') {
    return {
      kind: 'schedule',
      schedule: {
        kind: 'recurring-daily',
        timeZone: trigger.schedule.timeZone,
        hour: trigger.schedule.hour,
        minute: trigger.schedule.minute,
      },
    };
  }
  return {
    kind: 'schedule',
    schedule: {
      kind: 'recurring-weekly',
      timeZone: trigger.schedule.timeZone,
      hour: trigger.schedule.hour,
      minute: trigger.schedule.minute,
      daysOfWeek: [...trigger.schedule.daysOfWeek],
    },
  };
}

function sameEntryPoint(
  left: WorkflowUrlEntryPointRecord,
  right: WorkflowUrlEntryPointRecord,
): boolean {
  return left.kind === right.kind && left.url === right.url;
}

function sameTrigger(left: WorkflowTriggerRecord, right: WorkflowTriggerRecord): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'manual' || right.kind === 'manual') {
    return left.kind === 'manual' && right.kind === 'manual';
  }
  const leftSchedule = left.schedule;
  const rightSchedule = right.schedule;
  if (leftSchedule.kind !== rightSchedule.kind) {
    return false;
  }
  if (leftSchedule.kind === 'one-time' && rightSchedule.kind === 'one-time') {
    return leftSchedule.runAtUtc === rightSchedule.runAtUtc;
  }
  if (leftSchedule.kind === 'recurring-daily' && rightSchedule.kind === 'recurring-daily') {
    return (
      leftSchedule.timeZone === rightSchedule.timeZone &&
      leftSchedule.hour === rightSchedule.hour &&
      leftSchedule.minute === rightSchedule.minute
    );
  }
  if (leftSchedule.kind === 'recurring-weekly' && rightSchedule.kind === 'recurring-weekly') {
    return (
      leftSchedule.timeZone === rightSchedule.timeZone &&
      leftSchedule.hour === rightSchedule.hour &&
      leftSchedule.minute === rightSchedule.minute &&
      leftSchedule.daysOfWeek.length === rightSchedule.daysOfWeek.length &&
      leftSchedule.daysOfWeek.every((day, index) => day === rightSchedule.daysOfWeek[index])
    );
  }
  return false;
}

function requireEnqueueSource(source: WorkflowEnqueueSource): WorkflowEnqueueSource {
  if (source !== 'manual' && source !== 'scheduled') {
    throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'Enqueue source is invalid.');
  }
  return source;
}

function requireRunningTerminalState(state: RunningOccurrenceTerminalState): RunningOccurrenceTerminalState {
  if (
    state !== 'completed' &&
    state !== 'blocked' &&
    state !== 'failed' &&
    state !== 'cancelled' &&
    state !== 'execution-state-unknown'
  ) {
    throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'Terminal state is invalid.');
  }
  return state;
}

function resolveTerminalReason(
  state: RunningOccurrenceTerminalState,
  reason: string | null | undefined,
): string | null {
  if (state === 'completed') {
    if (reason === undefined || reason === null) {
      return WORKFLOW_TERMINAL_REASON.COMPLETED;
    }
    return requireBoundedToken(reason, MAX_TERMINAL_REASON_CHARS, 'terminalReason');
  }
  if (state === 'execution-state-unknown') {
    if (reason === undefined || reason === null) {
      return WORKFLOW_TERMINAL_REASON.EXECUTION_STATE_UNKNOWN;
    }
    return requireBoundedToken(reason, MAX_TERMINAL_REASON_CHARS, 'terminalReason');
  }
  if (state === 'cancelled') {
    if (reason === undefined || reason === null) {
      return WORKFLOW_TERMINAL_REASON.USER_CANCELLED;
    }
    return requireBoundedToken(reason, MAX_TERMINAL_REASON_CHARS, 'terminalReason');
  }
  if (reason === undefined || reason === null || reason.length === 0) {
    throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'Terminal reason is required.');
  }
  return requireBoundedToken(reason, MAX_TERMINAL_REASON_CHARS, 'terminalReason');
}

function resolveFinalAnswer(
  state: RunningOccurrenceTerminalState,
  finalAnswer: string | null | undefined,
): string | null {
  if (state === 'completed') {
    if (finalAnswer === undefined || finalAnswer === null || finalAnswer.length === 0) {
      throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'Completed occurrence requires a final answer.');
    }
    if (finalAnswer.length > MAX_WORKFLOW_FINAL_ANSWER_CHARS) {
      throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'Final answer is invalid.');
    }
    return finalAnswer;
  }
  if (finalAnswer !== undefined && finalAnswer !== null) {
    throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'Final answer is only allowed when completed.');
  }
  return null;
}

function requireRuntimeSessionId(value: string): string {
  return requireBoundedToken(value, MAX_RUNTIME_SESSION_ID_CHARS, 'runtimeSessionId');
}

function requireGeneratedId(value: string, maxChars: number, _label: string): string {
  return requireBoundedToken(value, maxChars, 'id');
}

function requireBoundedToken(value: string, maxChars: number, _label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars || value.trim() !== value) {
    throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'Request field is invalid.');
  }
  return value;
}

function requireNullableUtcInstant(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !UTC_INSTANT_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DurableWorkflowError('WORKFLOW_INVALID_REQUEST', 'scheduledFor is invalid.');
  }
  return value;
}
