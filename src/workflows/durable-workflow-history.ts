import {
  MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW,
  MAX_SCHEDULED_DEDUPE_ANCHORS_PER_WORKFLOW,
} from './durable-workflow-types';
import type {
  DurableWorkflowDefinitionRecord,
  WorkflowOccurrenceRecord,
} from './workflow-store-types';

const NONTERMINAL_STATES = new Set(['queued', 'running']);
const REVIEW_SENSITIVE_STATES = new Set(['interrupted', 'execution-state-unknown']);

/**
 * Per-workflow retention:
 * 1. Keep every nonterminal occurrence (`queued`, `running`).
 * 2. While `reviewRequired` is true, keep every `interrupted` /
 *    `execution-state-unknown` occurrence (review evidence).
 * 3. From remaining ordinary terminal history, keep the 50 newest by
 *    `finishedAt` descending, `occurrenceId` descending.
 * 4. Keep the latest occurrence with a non-null `scheduledFor` as the
 *    scheduled dedupe anchor (`scheduledFor` desc, `occurrenceId` desc)
 *    if it is not already retained. This preserves triggerKey
 *    idempotency across history compaction.
 *
 * The anchor is not duplicated if it is already kept as nonterminal,
 * review-sensitive, or one of the 50 newest ordinary terminals.
 * A terminal anchor older than that window may make ordinary retained
 * records 51 (50 + 1). Manual run-now rows (`scheduledFor = null`) are
 * never anchors, even if their frozen trigger is a schedule.
 */
export function pruneWorkflowOccurrenceHistory(
  workflows: readonly DurableWorkflowDefinitionRecord[],
  occurrences: readonly WorkflowOccurrenceRecord[],
): WorkflowOccurrenceRecord[] {
  const reviewByWorkflow = new Map(workflows.map((workflow) => [workflow.workflowId, workflow.reviewRequired]));
  const grouped = new Map<string, WorkflowOccurrenceRecord[]>();
  for (const occurrence of occurrences) {
    const list = grouped.get(occurrence.workflowId);
    if (list) {
      list.push(occurrence);
    } else {
      grouped.set(occurrence.workflowId, [occurrence]);
    }
  }

  const retained: WorkflowOccurrenceRecord[] = [];
  for (const [workflowId, list] of grouped) {
    retained.push(...pruneOneWorkflow(list, reviewByWorkflow.get(workflowId) === true));
  }
  return retained;
}

function pruneOneWorkflow(
  occurrences: readonly WorkflowOccurrenceRecord[],
  reviewRequired: boolean,
): WorkflowOccurrenceRecord[] {
  const keptIds = new Set<string>();
  const kept: WorkflowOccurrenceRecord[] = [];

  const keep = (occurrence: WorkflowOccurrenceRecord): void => {
    if (keptIds.has(occurrence.occurrenceId)) {
      return;
    }
    keptIds.add(occurrence.occurrenceId);
    kept.push(occurrence);
  };

  for (const occurrence of occurrences) {
    if (NONTERMINAL_STATES.has(occurrence.state)) {
      keep(occurrence);
    }
  }

  if (reviewRequired) {
    for (const occurrence of occurrences) {
      if (REVIEW_SENSITIVE_STATES.has(occurrence.state)) {
        keep(occurrence);
      }
    }
  }

  const ordinaryTerminal = occurrences.filter((occurrence) => !keptIds.has(occurrence.occurrenceId));
  ordinaryTerminal.sort(compareOrdinaryTerminalNewestFirst);
  for (const occurrence of ordinaryTerminal.slice(0, MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW)) {
    keep(occurrence);
  }

  const anchors = occurrences
    .filter((occurrence) => occurrence.scheduledFor !== null)
    .sort(compareScheduledAnchorNewestFirst)
    .slice(0, MAX_SCHEDULED_DEDUPE_ANCHORS_PER_WORKFLOW);
  for (const anchor of anchors) {
    keep(anchor);
  }

  return kept;
}

function compareScheduledAnchorNewestFirst(
  left: WorkflowOccurrenceRecord,
  right: WorkflowOccurrenceRecord,
): number {
  const scheduled = compareNullableInstantDescending(left.scheduledFor, right.scheduledFor);
  if (scheduled !== 0) {
    return scheduled;
  }
  if (left.occurrenceId === right.occurrenceId) {
    return 0;
  }
  return left.occurrenceId < right.occurrenceId ? 1 : -1;
}

function compareOrdinaryTerminalNewestFirst(
  left: WorkflowOccurrenceRecord,
  right: WorkflowOccurrenceRecord,
): number {
  const finished = compareNullableInstantDescending(left.finishedAt, right.finishedAt);
  if (finished !== 0) {
    return finished;
  }
  if (left.occurrenceId === right.occurrenceId) {
    return 0;
  }
  return left.occurrenceId < right.occurrenceId ? 1 : -1;
}

function compareNullableInstantDescending(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left < right ? 1 : -1;
}
