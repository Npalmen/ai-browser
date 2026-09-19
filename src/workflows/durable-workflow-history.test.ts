import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pruneWorkflowOccurrenceHistory } from './durable-workflow-history';
import {
  MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW,
  MAX_SCHEDULED_DEDUPE_ANCHORS_PER_WORKFLOW,
} from './durable-workflow-types';
import type {
  DurableWorkflowDefinitionRecord,
  WorkflowOccurrenceRecord,
  WorkflowOccurrenceState,
  WorkflowTriggerRecord,
} from './workflow-store-types';

const INSTANT = '2026-09-19T10:00:00.000Z';
const ONE_TIME_AT = '2026-09-19T08:00:00.000Z';
const RECURRING_T1 = '2026-09-01T08:00:00.000Z';
const RECURRING_T2 = '2026-09-02T08:00:00.000Z';
const SCHEDULED_TRIGGER: WorkflowTriggerRecord = {
  kind: 'schedule',
  schedule: { kind: 'one-time', runAtUtc: ONE_TIME_AT },
};
const RECURRING_TRIGGER: WorkflowTriggerRecord = {
  kind: 'schedule',
  schedule: { kind: 'recurring-daily', timeZone: 'UTC', hour: 8, minute: 0 },
};

describe('workflow occurrence history pruning', () => {
  it('locks the ordinary terminal and scheduled-anchor retention bounds', () => {
    assert.equal(MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW, 50);
    assert.equal(MAX_SCHEDULED_DEDUPE_ANCHORS_PER_WORKFLOW, 1);
  });

  it('keeps nonterminal occurrences and the newest ordinary terminals', () => {
    const workflow = definition('wf-1', false);
    const occurrences: WorkflowOccurrenceRecord[] = [
      occurrence('queued-1', 'wf-1', 'queued', null),
      occurrence('run-1', 'wf-1', 'running', null),
      ...completedManuals('wf-1', 52, 0),
    ];
    const retained = pruneWorkflowOccurrenceHistory([workflow], occurrences);
    assert.equal(retained.some((item) => item.occurrenceId === 'queued-1'), true);
    assert.equal(retained.some((item) => item.occurrenceId === 'run-1'), true);
    assert.equal(retained.some((item) => item.occurrenceId === 'done-00'), false);
    assert.equal(retained.some((item) => item.occurrenceId === 'done-01'), false);
    assert.equal(retained.some((item) => item.occurrenceId === 'done-51'), true);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
  });

  it('never prunes interrupted or unknown while review is required', () => {
    const workflow = definition('wf-1', true);
    const occurrences = [
      occurrence('unknown-1', 'wf-1', 'execution-state-unknown', '2026-09-19T09:00:00.000Z'),
      occurrence('interrupted-1', 'wf-1', 'interrupted', '2026-09-19T09:01:00.000Z'),
      ...completedManuals('wf-1', 50, 11),
    ];
    const retained = pruneWorkflowOccurrenceHistory([workflow], occurrences);
    assert.equal(retained.some((item) => item.occurrenceId === 'unknown-1'), true);
    assert.equal(retained.some((item) => item.occurrenceId === 'interrupted-1'), true);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
  });

  it('does not prune other workflows', () => {
    const retained = pruneWorkflowOccurrenceHistory(
      [definition('wf-1', false), definition('wf-2', false)],
      [
        occurrence('wf2-done', 'wf-2', 'completed', INSTANT),
        ...Array.from({ length: 51 }, (_, index) =>
          occurrence(`wf1-${index}`, 'wf-1', 'cancelled', `2026-09-19T10:${String(index).padStart(2, '0')}:00.000Z`),
        ),
      ],
    );
    assert.equal(retained.some((item) => item.occurrenceId === 'wf2-done'), true);
    assert.equal(retained.filter((item) => item.workflowId === 'wf-1').length, 50);
  });

  it('preserves a one-time scheduled terminal as the dedupe anchor after 51 newer manuals', () => {
    const workflow = definition('wf-1', false);
    const scheduled = scheduledOccurrence({
      occurrenceId: 'sched-once',
      workflowId: 'wf-1',
      scheduledFor: ONE_TIME_AT,
      finishedAt: '2026-09-19T09:00:00.000Z',
      trigger: SCHEDULED_TRIGGER,
    });
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [scheduled, ...completedManuals('wf-1', 51, 10)],
    );
    const ids = retained.map((item) => item.occurrenceId);
    assert.equal(ids.includes('sched-once'), true);
    assert.equal(retained.some((item) => item.triggerKey === scheduled.triggerKey), true);
    assert.equal(ids.includes('done-00'), false);
    assert.equal(ids.includes('done-50'), true);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 51);
  });

  it('does not duplicate the scheduled anchor when it already sits in the newest 50 terminals', () => {
    const workflow = definition('wf-1', false);
    const scheduled = scheduledOccurrence({
      occurrenceId: 'sched-newest',
      workflowId: 'wf-1',
      scheduledFor: ONE_TIME_AT,
      finishedAt: '2026-09-19T11:00:00.000Z',
      trigger: SCHEDULED_TRIGGER,
    });
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [scheduled, ...completedManuals('wf-1', 50, 10)],
    );
    assert.equal(retained.filter((item) => item.occurrenceId === 'sched-newest').length, 1);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
  });

  it('preserves a recurring scheduled terminal after 51 newer manuals', () => {
    const workflow = definition('wf-1', false);
    const scheduled = scheduledOccurrence({
      occurrenceId: 'sched-t1',
      workflowId: 'wf-1',
      scheduledFor: RECURRING_T1,
      finishedAt: '2026-09-01T08:05:00.000Z',
      trigger: RECURRING_TRIGGER,
    });
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [scheduled, ...completedManuals('wf-1', 51, 10)],
    );
    assert.equal(retained.some((item) => item.occurrenceId === 'sched-t1'), true);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 51);
  });

  it('lets a newer scheduled occurrence supersede the previous dedupe anchor', () => {
    const workflow = definition('wf-1', false);
    const older = scheduledOccurrence({
      occurrenceId: 'sched-t1',
      workflowId: 'wf-1',
      scheduledFor: RECURRING_T1,
      finishedAt: '2026-09-01T08:05:00.000Z',
      trigger: RECURRING_TRIGGER,
    });
    const newer = scheduledOccurrence({
      occurrenceId: 'sched-t2',
      workflowId: 'wf-1',
      scheduledFor: RECURRING_T2,
      finishedAt: '2026-09-19T11:00:00.000Z',
      trigger: RECURRING_TRIGGER,
    });
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [older, newer, ...completedManuals('wf-1', 51, 10)],
    );
    assert.equal(retained.some((item) => item.occurrenceId === 'sched-t2'), true);
    assert.equal(retained.some((item) => item.occurrenceId === 'sched-t1'), false);
    assert.equal(retained.filter((item) => item.scheduledFor !== null).length, 1);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
  });

  it('does not duplicate a nonterminal scheduled occurrence that is already the latest slot', () => {
    const workflow = definition('wf-1', false);
    const queued = scheduledOccurrence({
      occurrenceId: 'sched-queued',
      workflowId: 'wf-1',
      scheduledFor: RECURRING_T2,
      finishedAt: null,
      state: 'queued',
      trigger: RECURRING_TRIGGER,
    });
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [queued, ...completedManuals('wf-1', 50, 10)],
    );
    assert.equal(retained.filter((item) => item.occurrenceId === 'sched-queued').length, 1);
    assert.equal(retained.some((item) => item.state === 'queued'), true);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
  });

  it('keeps a review-sensitive scheduled occurrence once while review is required', () => {
    const workflow = definition('wf-1', true);
    const interrupted = scheduledOccurrence({
      occurrenceId: 'sched-interrupted',
      workflowId: 'wf-1',
      scheduledFor: ONE_TIME_AT,
      finishedAt: '2026-09-19T09:00:00.000Z',
      state: 'interrupted',
      trigger: SCHEDULED_TRIGGER,
    });
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [interrupted, ...completedManuals('wf-1', 50, 10)],
    );
    assert.equal(retained.filter((item) => item.occurrenceId === 'sched-interrupted').length, 1);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
  });

  it('still preserves the latest scheduled occurrence after review acknowledgement', () => {
    const workflow = definition('wf-1', false);
    const interrupted = scheduledOccurrence({
      occurrenceId: 'sched-interrupted',
      workflowId: 'wf-1',
      scheduledFor: ONE_TIME_AT,
      finishedAt: '2026-09-19T09:00:00.000Z',
      state: 'interrupted',
      trigger: SCHEDULED_TRIGGER,
    });
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [interrupted, ...completedManuals('wf-1', 51, 10)],
    );
    assert.equal(retained.some((item) => item.occurrenceId === 'sched-interrupted'), true);
    assert.equal(retained.filter((item) => item.occurrenceId === 'sched-interrupted').length, 1);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
    assert.equal(retained.filter((item) => item.state === 'interrupted').length, 1);
  });

  it('never treats a run-now occurrence with scheduledFor=null as the scheduled anchor', () => {
    const workflow = definition('wf-1', false);
    const runNow = occurrence(
      'manual-runnow',
      'wf-1',
      'completed',
      '2026-09-19T09:00:00.000Z',
      {
        scheduledFor: null,
        trigger: SCHEDULED_TRIGGER,
        triggerKey: 'manual:manual-runnow',
      },
    );
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [runNow, ...completedManuals('wf-1', 51, 10)],
    );
    assert.equal(retained.some((item) => item.occurrenceId === 'manual-runnow'), false);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
  });

  it('tie-breaks equal scheduledFor by occurrenceId descending', () => {
    const workflow = definition('wf-1', false);
    const lower = scheduledOccurrence({
      occurrenceId: 'sched-a',
      workflowId: 'wf-1',
      scheduledFor: RECURRING_T1,
      finishedAt: '2026-09-01T08:05:00.000Z',
      trigger: RECURRING_TRIGGER,
    });
    const higher = scheduledOccurrence({
      occurrenceId: 'sched-b',
      workflowId: 'wf-1',
      scheduledFor: RECURRING_T1,
      finishedAt: '2026-09-01T08:06:00.000Z',
      trigger: RECURRING_TRIGGER,
    });
    const retained = pruneWorkflowOccurrenceHistory(
      [workflow],
      [lower, higher, ...completedManuals('wf-1', 51, 10)],
    );
    assert.equal(retained.some((item) => item.occurrenceId === 'sched-b'), true);
    assert.equal(retained.some((item) => item.occurrenceId === 'sched-a'), false);
  });
});

function definition(workflowId: string, reviewRequired: boolean): DurableWorkflowDefinitionRecord {
  return {
    workflowId,
    definitionRevision: 1,
    name: 'n',
    objective: 'o',
    entryPoint: { kind: 'url', url: 'https://example.com/path' },
    trigger: { kind: 'manual' },
    enabled: true,
    reviewRequired,
    createdAt: INSTANT,
    updatedAt: INSTANT,
  };
}

function completedManuals(
  workflowId: string,
  count: number,
  hour: number,
): WorkflowOccurrenceRecord[] {
  return Array.from({ length: count }, (_, index) =>
    occurrence(
      `done-${String(index).padStart(2, '0')}`,
      workflowId,
      'completed',
      `2026-09-19T${String(hour).padStart(2, '0')}:${String(index).padStart(2, '0')}:00.000Z`,
    ),
  );
}

function scheduledOccurrence(input: {
  occurrenceId: string;
  workflowId: string;
  scheduledFor: string;
  finishedAt: string | null;
  state?: WorkflowOccurrenceState;
  trigger: WorkflowTriggerRecord;
}): WorkflowOccurrenceRecord {
  const state = input.state ?? 'completed';
  return occurrence(input.occurrenceId, input.workflowId, state, input.finishedAt, {
    scheduledFor: input.scheduledFor,
    trigger: input.trigger,
    triggerKey: `${input.workflowId}:${input.scheduledFor}`,
  });
}

function occurrence(
  occurrenceId: string,
  workflowId: string,
  state: WorkflowOccurrenceState,
  finishedAt: string | null,
  options: {
    scheduledFor?: string | null;
    trigger?: WorkflowTriggerRecord;
    triggerKey?: string;
  } = {},
): WorkflowOccurrenceRecord {
  const terminal = finishedAt !== null;
  return {
    occurrenceId,
    workflowId,
    definitionRevision: 1,
    triggerKey: options.triggerKey ?? `key:${occurrenceId}`,
    scheduledFor: options.scheduledFor ?? null,
    frozenDefinition: {
      objective: 'o',
      entryPoint: { kind: 'url', url: 'https://example.com/path' },
      trigger: options.trigger ?? { kind: 'manual' },
    },
    state,
    createdAt: INSTANT,
    startedAt: state === 'queued' ? null : INSTANT,
    finishedAt,
    ownerRuntimeSessionId: state === 'running' ? 'runtime-1' : null,
    terminalReason: terminal
      ? state === 'interrupted'
        ? 'INTERRUPTED'
        : state === 'execution-state-unknown'
          ? 'EXECUTION_STATE_UNKNOWN'
          : 'COMPLETED'
      : null,
    finalAnswer: state === 'completed' ? 'done' : null,
  };
}
