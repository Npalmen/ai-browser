import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pruneWorkflowOccurrenceHistory } from './durable-workflow-history';
import { MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW } from './durable-workflow-types';
import type {
  DurableWorkflowDefinitionRecord,
  WorkflowOccurrenceRecord,
  WorkflowOccurrenceState,
} from './workflow-store-types';

const INSTANT = '2026-09-19T10:00:00.000Z';

describe('workflow occurrence history pruning', () => {
  it('locks the ordinary terminal retention bound', () => {
    assert.equal(MAX_ORDINARY_TERMINAL_HISTORY_PER_WORKFLOW, 50);
  });

  it('keeps nonterminal occurrences and the newest ordinary terminals', () => {
    const workflow = definition('wf-1', false);
    const occurrences: WorkflowOccurrenceRecord[] = [
      occurrence('queued-1', 'wf-1', 'queued', null),
      occurrence('run-1', 'wf-1', 'running', null),
      ...Array.from({ length: 52 }, (_, index) =>
        occurrence(`done-${String(index).padStart(2, '0')}`, 'wf-1', 'completed', `2026-09-19T10:${String(index).padStart(2, '0')}:00.000Z`),
      ),
    ];
    const retained = pruneWorkflowOccurrenceHistory([workflow], occurrences);
    const ids = retained.map((item) => item.occurrenceId).sort();
    assert.equal(retained.some((item) => item.occurrenceId === 'queued-1'), true);
    assert.equal(retained.some((item) => item.occurrenceId === 'run-1'), true);
    assert.equal(retained.some((item) => item.occurrenceId === 'done-00'), false);
    assert.equal(retained.some((item) => item.occurrenceId === 'done-01'), false);
    assert.equal(retained.some((item) => item.occurrenceId === 'done-51'), true);
    assert.equal(retained.filter((item) => item.state === 'completed').length, 50);
    assert.equal(ids.includes('done-02'), true);
  });

  it('never prunes interrupted or unknown while review is required', () => {
    const workflow = definition('wf-1', true);
    const occurrences = [
      occurrence('unknown-1', 'wf-1', 'execution-state-unknown', '2026-09-19T09:00:00.000Z'),
      occurrence('interrupted-1', 'wf-1', 'interrupted', '2026-09-19T09:01:00.000Z'),
      ...Array.from({ length: 50 }, (_, index) =>
        occurrence(`done-${index}`, 'wf-1', 'completed', `2026-09-19T11:${String(index).padStart(2, '0')}:00.000Z`),
      ),
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

function occurrence(
  occurrenceId: string,
  workflowId: string,
  state: WorkflowOccurrenceState,
  finishedAt: string | null,
): WorkflowOccurrenceRecord {
  const terminal = finishedAt !== null;
  return {
    occurrenceId,
    workflowId,
    definitionRevision: 1,
    triggerKey: `key:${occurrenceId}`,
    scheduledFor: null,
    frozenDefinition: {
      objective: 'o',
      entryPoint: { kind: 'url', url: 'https://example.com/path' },
      trigger: { kind: 'manual' },
    },
    state,
    createdAt: INSTANT,
    startedAt: state === 'queued' ? null : INSTANT,
    finishedAt,
    ownerRuntimeSessionId: state === 'running' ? 'runtime-1' : null,
    terminalReason: terminal ? 'COMPLETED' : null,
    finalAnswer: state === 'completed' ? 'done' : null,
  };
}
