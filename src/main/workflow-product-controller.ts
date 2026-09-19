import type {
  WorkflowCreateInput,
  WorkflowDetailView,
  WorkflowEditInput,
  WorkflowGetDetailResult,
  WorkflowGetStateResult,
  WorkflowLastResultView,
  WorkflowMutationResult,
  WorkflowOccurrenceView,
  WorkflowProductTrigger,
  WorkflowSummaryView,
  WorkflowTerminalResultState,
} from '../shared/workflow-product-types';
import type {
  DurableWorkflowDefinitionRecord,
  WorkflowOccurrenceRecord,
} from '../workflows/workflow-store-types';
import { TERMINAL_WORKFLOW_OCCURRENCE_STATES } from '../workflows/workflow-store-types';
import { evaluateWorkflowSchedule } from '../workflows/workflow-schedule';
import type { PersistentWorkflowRuntime } from './persistent-workflow-runtime';
import { toWorkflowProductError, workflowProductError } from './workflow-product-safe-error';

const TERMINAL_STATES = new Set<string>(TERMINAL_WORKFLOW_OCCURRENCE_STATES);

export class WorkflowProductController {
  constructor(private readonly runtime: PersistentWorkflowRuntime) {}

  async getState(now: Date = new Date()): Promise<WorkflowGetStateResult> {
    if (this.runtime.status === 'storage-error') {
      return { ok: true, status: 'storage-error', workflows: [] };
    }
    if (this.runtime.status !== 'ready') {
      return { ok: true, status: 'not-initialized', workflows: [] };
    }
    const coordinator = this.runtime.getCoordinator();
    if (coordinator === undefined) {
      return { ok: true, status: 'not-initialized', workflows: [] };
    }
    try {
      const workflows = await coordinator.listWorkflows();
      const summaries: WorkflowSummaryView[] = [];
      for (const workflow of workflows) {
        const occurrences = await coordinator.listOccurrences(workflow.workflowId);
        summaries.push(toWorkflowSummaryView(workflow, occurrences, now));
      }
      return { ok: true, status: 'ready', workflows: summaries };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async getDetail(workflowId: string, now: Date = new Date()): Promise<WorkflowGetDetailResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    const coordinator = this.runtime.getCoordinator();
    if (coordinator === undefined) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    try {
      const workflow = await coordinator.getWorkflow(workflowId);
      if (workflow === undefined) {
        return { ok: false, error: workflowProductError('WORKFLOW_NOT_FOUND') };
      }
      const occurrences = await coordinator.listOccurrences(workflowId);
      return { ok: true, workflow: toWorkflowDetailView(workflow, occurrences, now) };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async create(input: WorkflowCreateInput): Promise<WorkflowMutationResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    try {
      const created = await this.runtime.createWorkflow({
        name: input.name,
        objective: input.objective,
        entryPoint: input.entryPoint,
        trigger: input.trigger,
        enabled: input.enabled,
      });
      return { ok: true, workflowId: created.workflowId };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async edit(input: WorkflowEditInput): Promise<WorkflowMutationResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    try {
      await this.runtime.editWorkflow(input.workflowId, {
        name: input.name,
        objective: input.objective,
        entryPoint: input.entryPoint,
        trigger: input.trigger,
      });
      return { ok: true, workflowId: input.workflowId };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async setEnabled(workflowId: string, enabled: boolean): Promise<WorkflowMutationResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    try {
      await this.runtime.setWorkflowEnabled(workflowId, enabled);
      return { ok: true, workflowId };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async runNow(workflowId: string): Promise<WorkflowMutationResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    try {
      await this.runtime.runWorkflowNow(workflowId);
      return { ok: true, workflowId };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async acknowledgeReview(workflowId: string): Promise<WorkflowMutationResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    try {
      await this.runtime.acknowledgeWorkflowReview(workflowId);
      return { ok: true, workflowId };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async stop(workflowId: string): Promise<WorkflowMutationResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    const active = this.runtime.getRunner()?.getActiveOccurrence();
    if (active === undefined || active.workflowId !== workflowId) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_FOUND') };
    }
    try {
      const result = await this.runtime.stopActiveWorkflowOccurrence();
      if (!result.ok) {
        return { ok: false, error: workflowProductError('WORKFLOW_OPERATION_FAILED') };
      }
      return { ok: true, workflowId };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async cancelQueued(workflowId: string, occurrenceId: string): Promise<WorkflowMutationResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    const coordinator = this.runtime.getCoordinator();
    if (coordinator === undefined) {
      return { ok: false, error: workflowProductError('WORKFLOW_NOT_AVAILABLE') };
    }
    try {
      const occurrence = await coordinator.getOccurrence(occurrenceId);
      if (occurrence === undefined || occurrence.workflowId !== workflowId) {
        return { ok: false, error: workflowProductError('WORKFLOW_NOT_FOUND') };
      }
      await this.runtime.cancelQueuedOccurrence(occurrenceId);
      return { ok: true, workflowId };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  async delete(workflowId: string): Promise<WorkflowMutationResult> {
    const unavailable = this.unavailableError();
    if (unavailable) {
      return { ok: false, error: unavailable };
    }
    try {
      await this.runtime.deleteWorkflow(workflowId);
      return { ok: true, workflowId };
    } catch (error) {
      return { ok: false, error: toWorkflowProductError(error) };
    }
  }

  private unavailableError() {
    if (this.runtime.status === 'storage-error') {
      return workflowProductError('WORKFLOW_STORAGE_ERROR');
    }
    if (this.runtime.status !== 'ready' || this.runtime.getCoordinator() === undefined) {
      return workflowProductError('WORKFLOW_NOT_AVAILABLE');
    }
    return undefined;
  }
}

export function toWorkflowSummaryView(
  workflow: DurableWorkflowDefinitionRecord,
  occurrences: readonly WorkflowOccurrenceRecord[],
  now: Date,
): WorkflowSummaryView {
  const own = occurrences.filter((occurrence) => occurrence.workflowId === workflow.workflowId);
  return {
    workflowId: workflow.workflowId,
    name: workflow.name,
    enabled: workflow.enabled,
    reviewRequired: workflow.reviewRequired,
    definitionRevision: workflow.definitionRevision,
    trigger: toProductTrigger(workflow.trigger),
    nextRunAt: nextRunAt(workflow.trigger, now),
    queuedCount: own.filter((occurrence) => occurrence.state === 'queued').length,
    running: own.some((occurrence) => occurrence.state === 'running'),
    lastResult: lastResult(own),
  };
}

export function toWorkflowDetailView(
  workflow: DurableWorkflowDefinitionRecord,
  occurrences: readonly WorkflowOccurrenceRecord[],
  now: Date,
): WorkflowDetailView {
  const own = occurrences
    .filter((occurrence) => occurrence.workflowId === workflow.workflowId)
    .slice()
    .sort(compareOccurrenceHistory)
    .map(toOccurrenceView);
  return {
    workflowId: workflow.workflowId,
    definitionRevision: workflow.definitionRevision,
    name: workflow.name,
    objective: workflow.objective,
    entryPoint: { kind: 'url', url: workflow.entryPoint.url },
    trigger: toProductTrigger(workflow.trigger),
    enabled: workflow.enabled,
    reviewRequired: workflow.reviewRequired,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    nextRunAt: nextRunAt(workflow.trigger, now),
    occurrences: own,
  };
}

export function toOccurrenceView(occurrence: WorkflowOccurrenceRecord): WorkflowOccurrenceView {
  return {
    occurrenceId: occurrence.occurrenceId,
    state: occurrence.state,
    source: occurrence.triggerKey.startsWith('manual:') ? 'manual' : 'scheduled',
    scheduledFor: occurrence.scheduledFor,
    createdAt: occurrence.createdAt,
    startedAt: occurrence.startedAt,
    finishedAt: occurrence.finishedAt,
    ...(occurrence.terminalReason ? { terminalReason: occurrence.terminalReason } : {}),
    ...(occurrence.finalAnswer ? { finalAnswer: occurrence.finalAnswer } : {}),
  };
}

function toProductTrigger(trigger: DurableWorkflowDefinitionRecord['trigger']): WorkflowProductTrigger {
  if (trigger.kind === 'manual') {
    return { kind: 'manual' };
  }
  const schedule = trigger.schedule;
  if (schedule.kind === 'one-time') {
    return { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc: schedule.runAtUtc } };
  }
  if (schedule.kind === 'recurring-daily') {
    return {
      kind: 'schedule',
      schedule: {
        kind: 'recurring-daily',
        timeZone: schedule.timeZone,
        hour: schedule.hour,
        minute: schedule.minute,
      },
    };
  }
  return {
    kind: 'schedule',
    schedule: {
      kind: 'recurring-weekly',
      timeZone: schedule.timeZone,
      hour: schedule.hour,
      minute: schedule.minute,
      daysOfWeek: [...schedule.daysOfWeek],
    },
  };
}

function nextRunAt(trigger: DurableWorkflowDefinitionRecord['trigger'], now: Date): string | null {
  if (trigger.kind === 'manual') {
    return null;
  }
  try {
    return evaluateWorkflowSchedule(trigger, now).nextFuture;
  } catch {
    return null;
  }
}

function lastResult(occurrences: readonly WorkflowOccurrenceRecord[]): WorkflowLastResultView | null {
  const terminal = occurrences.filter(
    (occurrence) =>
      TERMINAL_STATES.has(occurrence.state) &&
      typeof occurrence.finishedAt === 'string' &&
      occurrence.finishedAt.length > 0,
  );
  if (terminal.length === 0) {
    return null;
  }
  terminal.sort((left, right) => {
    const finished = (right.finishedAt ?? '').localeCompare(left.finishedAt ?? '');
    if (finished !== 0) {
      return finished;
    }
    return right.occurrenceId.localeCompare(left.occurrenceId);
  });
  const latest = terminal[0]!;
  return {
    state: latest.state as WorkflowTerminalResultState,
    finishedAt: latest.finishedAt as string,
    ...(latest.finalAnswer ? { finalAnswer: latest.finalAnswer } : {}),
    ...(latest.terminalReason ? { terminalReason: latest.terminalReason } : {}),
  };
}

function compareOccurrenceHistory(left: WorkflowOccurrenceRecord, right: WorkflowOccurrenceRecord): number {
  const created = right.createdAt.localeCompare(left.createdAt);
  if (created !== 0) {
    return created;
  }
  return right.occurrenceId.localeCompare(left.occurrenceId);
}
