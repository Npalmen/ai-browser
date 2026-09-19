import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { WorkflowStoreError } from './workflow-store-errors';
import {
  parseWorkflowEntryUrl,
  parseWorkflowStoreJson,
  parseWorkflowStorePayload,
  parseWorkflowStoreSnapshot,
  serializeWorkflowStoreSnapshot,
} from './workflow-store-schema';
import {
  FORBIDDEN_WORKFLOW_STORE_FIELD_NAMES,
  MAX_WORKFLOW_ENTRY_URL_CHARS,
  MAX_WORKFLOW_FINAL_ANSWER_CHARS,
  MAX_WORKFLOW_ID_CHARS,
  MAX_WORKFLOW_NAME_CHARS,
  MAX_WORKFLOW_OBJECTIVE_CHARS,
  MAX_WORKFLOW_STORE_BYTES,
  MAX_WORKFLOW_TIMEZONE_CHARS,
  WORKFLOW_DEFINITION_KEYS,
  WORKFLOW_OCCURRENCE_KEYS,
  WORKFLOW_STORE_SCHEMA_VERSION,
  WORKFLOW_STORE_TOP_LEVEL_KEYS,
  type DurableWorkflowDefinitionRecord,
  type WorkflowOccurrenceRecord,
  type WorkflowStoreSnapshot,
} from './workflow-store-types';

const INSTANT = '2026-09-19T10:00:00.000Z';

describe('workflow store schema', () => {
  it('locks schema version and store byte bound', () => {
    assert.equal(WORKFLOW_STORE_SCHEMA_VERSION, 1);
    assert.equal(MAX_WORKFLOW_STORE_BYTES, 8 * 1024 * 1024);
    assert.equal(MAX_WORKFLOW_OBJECTIVE_CHARS, 4000);
    assert.equal(MAX_WORKFLOW_FINAL_ANSWER_CHARS, 4000);
    assert.equal(MAX_WORKFLOW_ENTRY_URL_CHARS, 2048);
  });

  it('round-trips a valid empty snapshot', () => {
    const snapshot = parseWorkflowStoreSnapshot(emptySnapshot());
    assert.deepEqual(snapshot, emptySnapshot());
    const again = parseWorkflowStoreJson(serializeWorkflowStoreSnapshot(snapshot));
    assert.deepEqual(again, snapshot);
  });

  it('accepts a valid workflow and occurrence set', () => {
    const snapshot = parseWorkflowStoreSnapshot(fullSnapshot());
    assert.equal(snapshot.workflows.length, 1);
    assert.equal(snapshot.occurrences.length, 1);
    assert.equal(snapshot.occurrences[0]?.frozenDefinition.entryPoint.url, 'https://example.com/path?resource=123');
  });

  it('rejects invalid JSON', () => {
    assertCorrupt('{ this is not json');
  });

  it('rejects a JSON array or primitive at the top level', () => {
    assertCorrupt('[]');
    assertCorrupt('1');
    assertCorrupt('"store"');
    assertCorrupt('null');
  });

  it('rejects unsupported schemaVersion', () => {
    assertUnsupported({ ...emptySnapshot(), schemaVersion: 999 });
    assertUnsupported({ ...emptySnapshot(), schemaVersion: 0 });
    assertUnsupported({ ...emptySnapshot(), schemaVersion: 2 });
  });

  it('rejects missing required top-level fields', () => {
    const missing = { schemaVersion: 1, storeRevision: 0, workflows: [] };
    assertCorrupt(JSON.stringify(missing));
  });

  it('rejects unknown top-level fields', () => {
    assertCorrupt(JSON.stringify({ ...emptySnapshot(), tabId: 'tab-1' }));
    assertCorrupt(JSON.stringify({ ...emptySnapshot(), extra: true }));
  });

  it('rejects extra authority fields on nested records', () => {
    const workflow = { ...validWorkflow(), approvalId: 'approval-1' };
    assertCorrupt(JSON.stringify({ ...emptySnapshot(), workflows: [workflow] }));

    const occurrence = { ...queuedOccurrence(), targetId: 'target-1' };
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [validWorkflow()],
        occurrences: [occurrence],
      }),
    );
  });

  it('rejects duplicate workflowId, occurrenceId, and triggerKey', () => {
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [validWorkflow(), validWorkflow()],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [validWorkflow()],
        occurrences: [queuedOccurrence(), queuedOccurrence()],
      }),
    );
    const otherId = { ...queuedOccurrence(), occurrenceId: 'occ-2' };
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [validWorkflow()],
        occurrences: [queuedOccurrence(), otherId],
      }),
    );
  });

  it('rejects a dangling occurrence workflowId', () => {
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        occurrences: [queuedOccurrence()],
      }),
    );
  });

  it('rejects definitionRevision below 1', () => {
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [{ ...validWorkflow(), definitionRevision: 0 }],
      }),
    );
  });

  it('allows an occurrence definitionRevision different from the current workflow revision', () => {
    const snapshot = parseWorkflowStoreSnapshot({
      ...emptySnapshot(),
      workflows: [{ ...validWorkflow(), definitionRevision: 4 }],
      occurrences: [{ ...queuedOccurrence(), definitionRevision: 1 }],
    });
    assert.equal(snapshot.occurrences[0]?.definitionRevision, 1);
    assert.equal(snapshot.workflows[0]?.definitionRevision, 4);
  });

  it('validates occurrence state consistency', () => {
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [validWorkflow()],
        occurrences: [{ ...queuedOccurrence(), startedAt: INSTANT }],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [validWorkflow()],
        occurrences: [
          {
            ...queuedOccurrence(),
            state: 'running',
            startedAt: INSTANT,
            ownerRuntimeSessionId: null,
          },
        ],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [validWorkflow()],
        occurrences: [
          {
            ...queuedOccurrence(),
            state: 'blocked',
            startedAt: INSTANT,
            finishedAt: INSTANT,
            finalAnswer: 'should not persist',
          },
        ],
      }),
    );
  });

  it('accepts completed finalAnswer and running owner session metadata', () => {
    const completed: WorkflowOccurrenceRecord = {
      ...queuedOccurrence(),
      state: 'completed',
      startedAt: INSTANT,
      finishedAt: '2026-09-19T10:05:00.000Z',
      terminalReason: 'COMPLETED',
      finalAnswer: 'done',
    };
    parseWorkflowStoreSnapshot({
      ...emptySnapshot(),
      workflows: [validWorkflow()],
      occurrences: [completed],
    });

    const running: WorkflowOccurrenceRecord = {
      ...queuedOccurrence(),
      occurrenceId: 'occ-run',
      triggerKey: 'manual:occ-run',
      state: 'running',
      startedAt: INSTANT,
      ownerRuntimeSessionId: 'runtime-1',
    };
    parseWorkflowStoreSnapshot({
      ...emptySnapshot(),
      workflows: [validWorkflow()],
      occurrences: [running],
    });
  });

  it('rejects malformed timestamps and offsets other than Z', () => {
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [{ ...validWorkflow(), createdAt: '2026-09-19T10:00:00+02:00' }],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [{ ...validWorkflow(), createdAt: 'tonight' }],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [{ ...validWorkflow(), createdAt: '2026-09-19 10:00:00Z' }],
      }),
    );
  });

  it('validates schedule shape without computing due times', () => {
    parseWorkflowStoreSnapshot({
      ...emptySnapshot(),
      workflows: [
        {
          ...validWorkflow(),
          trigger: {
            kind: 'schedule',
            schedule: {
              kind: 'recurring-weekly',
              timeZone: 'Europe/Stockholm',
              hour: 9,
              minute: 30,
              daysOfWeek: [1, 5],
            },
          },
        },
      ],
    });
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [
          {
            ...validWorkflow(),
            trigger: {
              kind: 'schedule',
              schedule: { kind: 'recurring-daily', timeZone: 'UTC', hour: 24, minute: 0 },
            },
          },
        ],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [
          {
            ...validWorkflow(),
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-weekly',
                timeZone: 'UTC',
                hour: 9,
                minute: 0,
                daysOfWeek: [1, 1],
              },
            },
          },
        ],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [
          {
            ...validWorkflow(),
            trigger: {
              kind: 'schedule',
              schedule: { kind: 'cron', expression: '* * * * *' },
            },
          },
        ],
      }),
    );
  });

  it('accepts http(s) entry URLs including query strings and rejects unsafe URLs', () => {
    assert.equal(
      parseWorkflowEntryUrl('https://example.com/path?resource=123'),
      'https://example.com/path?resource=123',
    );
    assert.equal(parseWorkflowEntryUrl('http://localhost/path'), 'http://localhost/path');

    const rejected = [
      'https://user@example.com/',
      'https://user:pass@example.com/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hello',
      'about:blank',
      'blob:https://example.com/uuid',
      'chrome://settings',
      'chrome-extension://abc/page.html',
    ];
    for (const url of rejected) {
      assert.throws(
        () => parseWorkflowEntryUrl(url),
        (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_CORRUPT',
        url,
      );
    }
  });

  it('does not rewrite a valid entry URL', () => {
    const url = 'https://example.com/path?resource=123';
    const workflow = { ...validWorkflow(), entryPoint: { kind: 'url' as const, url } };
    const snapshot = parseWorkflowStoreSnapshot({
      ...emptySnapshot(),
      workflows: [workflow],
    });
    assert.equal(snapshot.workflows[0]?.entryPoint.url, url);
  });

  it('rejects oversized identifiers and text', () => {
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [{ ...validWorkflow(), workflowId: 'w'.repeat(MAX_WORKFLOW_ID_CHARS + 1) }],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [{ ...validWorkflow(), name: 'n'.repeat(MAX_WORKFLOW_NAME_CHARS + 1) }],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [{ ...validWorkflow(), objective: 'o'.repeat(MAX_WORKFLOW_OBJECTIVE_CHARS + 1) }],
      }),
    );
    assertCorrupt(
      JSON.stringify({
        ...emptySnapshot(),
        workflows: [
          {
            ...validWorkflow(),
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-daily',
                timeZone: 'Z'.repeat(MAX_WORKFLOW_TIMEZONE_CHARS + 1),
                hour: 1,
                minute: 0,
              },
            },
          },
        ],
      }),
    );
  });

  it('rejects mutation payloads that are not exactly workflows and occurrences', () => {
    assert.throws(
      () => parseWorkflowStorePayload({ workflows: [], occurrences: [], storeRevision: 1 }),
      (error: unknown) =>
        error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_MUTATION_INVALID',
    );
  });

  it('does not declare forbidden authority or secret field names on persisted records', () => {
    const allowed = new Set<string>([
      ...WORKFLOW_STORE_TOP_LEVEL_KEYS,
      ...WORKFLOW_DEFINITION_KEYS,
      ...WORKFLOW_OCCURRENCE_KEYS,
      'kind',
      'url',
      'schedule',
      'runAtUtc',
      'timeZone',
      'hour',
      'minute',
      'daysOfWeek',
    ]);
    for (const field of FORBIDDEN_WORKFLOW_STORE_FIELD_NAMES) {
      assert.equal(allowed.has(field), false, field);
    }

    const schemaSource = readFileSync(path.join(__dirname, 'workflow-store-types.ts'), 'utf8');
    for (const field of FORBIDDEN_WORKFLOW_STORE_FIELD_NAMES) {
      assert.match(schemaSource, new RegExp(`'${field}'`));
    }
  });
});

function emptySnapshot(): WorkflowStoreSnapshot {
  return {
    schemaVersion: 1,
    storeRevision: 0,
    workflows: [],
    occurrences: [],
  };
}

function validWorkflow(): DurableWorkflowDefinitionRecord {
  return {
    workflowId: 'wf-1',
    definitionRevision: 1,
    name: 'Invoice check',
    objective: 'Open the invoice page and summarize totals.',
    entryPoint: { kind: 'url', url: 'https://example.com/path?resource=123' },
    trigger: { kind: 'manual' },
    enabled: true,
    reviewRequired: false,
    createdAt: INSTANT,
    updatedAt: INSTANT,
  };
}

function queuedOccurrence(): WorkflowOccurrenceRecord {
  return {
    occurrenceId: 'occ-1',
    workflowId: 'wf-1',
    definitionRevision: 1,
    triggerKey: 'manual:occ-1',
    scheduledFor: null,
    frozenDefinition: {
      objective: 'Open the invoice page and summarize totals.',
      entryPoint: { kind: 'url', url: 'https://example.com/path?resource=123' },
      trigger: { kind: 'manual' },
    },
    state: 'queued',
    createdAt: INSTANT,
    startedAt: null,
    finishedAt: null,
    ownerRuntimeSessionId: null,
    terminalReason: null,
    finalAnswer: null,
  };
}

function fullSnapshot(): WorkflowStoreSnapshot {
  return {
    schemaVersion: 1,
    storeRevision: 3,
    workflows: [validWorkflow()],
    occurrences: [queuedOccurrence()],
  };
}

function assertCorrupt(raw: unknown): void {
  const value = typeof raw === 'string' ? () => parseWorkflowStoreJson(raw) : () => parseWorkflowStoreSnapshot(raw);
  assert.throws(
    value,
    (error: unknown) => error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_CORRUPT',
  );
}

function assertUnsupported(value: unknown): void {
  assert.throws(
    () => parseWorkflowStoreSnapshot(value),
    (error: unknown) =>
      error instanceof WorkflowStoreError && error.code === 'WORKFLOW_STORE_SCHEMA_UNSUPPORTED',
  );
}
