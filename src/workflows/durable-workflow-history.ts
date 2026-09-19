import {
  MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW,
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
 *
 * After review is acknowledged, interrupted/unknown compete in the ordinary
 * 50-record terminal window.
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
  const kept: WorkflowOccurrenceRecord[] = [];
  const ordinaryTerminal: WorkflowOccurrenceRecord[] = [];
  for (const occurrence of occurrences) {
    if (NONTERMINAL_STATES.has(occurrence.state)) {
      kept.push(occurrence);
      continue;
    }
    if (reviewRequired && REVIEW_SENSITIVE_STATES.has(occurrence.state)) {
      kept.push(occurrence);
      continue;
    }
    ordinaryTerminal.push(occurrence);
  }
  ordinaryTerminal.sort(compareOrdinaryTerminalNewestFirst);
  kept.push(...ordinaryTerminal.slice(0, MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW));
  return kept;
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
