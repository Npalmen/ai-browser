import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_WORKFLOW_ENTRY_URL_CHARS,
  MAX_WORKFLOW_NAME_CHARS,
  MAX_WORKFLOW_OBJECTIVE_CHARS,
  MAX_WORKFLOW_TIMEZONE_CHARS,
} from '../workflows/workflow-store-types';
import { parseWorkflowDraft, WorkflowDraftValidationError } from './workflow-draft';

function validManual(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Status check',
    objective: 'Check the status page for outages.',
    entryPoint: { kind: 'url', url: 'https://example.test/status?site=1' },
    trigger: { kind: 'manual' },
    ...overrides,
  };
}

describe('parseWorkflowDraft', () => {
  it('accepts a valid manual draft', () => {
    const draft = parseWorkflowDraft(validManual());
    assert.equal(draft.name, 'Status check');
    assert.equal(draft.entryPoint.url, 'https://example.test/status?site=1');
    assert.equal(draft.trigger.kind, 'manual');
    assert.equal('enabled' in draft, false);
    assert.equal('workflowId' in draft, false);
  });

  it('accepts a valid one-time draft and canonicalizes the instant', () => {
    const draft = parseWorkflowDraft(
      validManual({
        trigger: {
          kind: 'schedule',
          schedule: { kind: 'one-time', runAtUtc: '2026-09-21T08:00:00Z' },
        },
      }),
    );
    assert.equal(draft.trigger.kind, 'schedule');
    if (draft.trigger.kind === 'schedule') {
      assert.equal(draft.trigger.schedule.kind, 'one-time');
      if (draft.trigger.schedule.kind === 'one-time') {
        assert.equal(draft.trigger.schedule.runAtUtc, '2026-09-21T08:00:00.000Z');
      }
    }
  });

  it('accepts a valid daily draft', () => {
    const draft = parseWorkflowDraft(
      validManual({
        trigger: {
          kind: 'schedule',
          schedule: {
            kind: 'recurring-daily',
            timeZone: 'Europe/Stockholm',
            hour: 8,
            minute: 0,
          },
        },
      }),
    );
    assert.equal(draft.trigger.kind, 'schedule');
    if (draft.trigger.kind === 'schedule' && draft.trigger.schedule.kind === 'recurring-daily') {
      assert.equal(draft.trigger.schedule.timeZone, 'Europe/Stockholm');
      assert.equal(draft.trigger.schedule.hour, 8);
    }
  });

  it('accepts a valid weekly draft', () => {
    const draft = parseWorkflowDraft(
      validManual({
        trigger: {
          kind: 'schedule',
          schedule: {
            kind: 'recurring-weekly',
            timeZone: 'America/New_York',
            hour: 8,
            minute: 0,
            daysOfWeek: [1, 2, 3, 4, 5],
          },
        },
      }),
    );
    assert.equal(draft.trigger.kind, 'schedule');
    if (draft.trigger.kind === 'schedule' && draft.trigger.schedule.kind === 'recurring-weekly') {
      assert.deepEqual(draft.trigger.schedule.daysOfWeek, [1, 2, 3, 4, 5]);
    }
  });

  it('rejects unknown top-level keys', () => {
    assert.throws(
      () => parseWorkflowDraft(validManual({ extra: true })),
      WorkflowDraftValidationError,
    );
  });

  it('rejects enabled, workflowId, and other authority-shaped extras', () => {
    for (const extra of [
      { enabled: true },
      { workflowId: 'wf-1' },
      { taskId: 'task-1' },
      { approvalId: 'a-1' },
      { targetId: 't-1' },
      { occurrenceId: 'occ-1' },
      { runNow: true },
      { grant: {} },
    ]) {
      assert.throws(
        () => parseWorkflowDraft({ ...validManual(), ...extra }),
        WorkflowDraftValidationError,
        JSON.stringify(extra),
      );
    }
  });

  it('rejects oversized name, objective, URL, and timezone', () => {
    assert.throws(
      () => parseWorkflowDraft(validManual({ name: 'n'.repeat(MAX_WORKFLOW_NAME_CHARS + 1) })),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(validManual({ objective: 'o'.repeat(MAX_WORKFLOW_OBJECTIVE_CHARS + 1) })),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            entryPoint: {
              kind: 'url',
              url: `https://example.test/${'a'.repeat(MAX_WORKFLOW_ENTRY_URL_CHARS)}`,
            },
          }),
        ),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-daily',
                timeZone: 'Z'.repeat(MAX_WORKFLOW_TIMEZONE_CHARS + 1),
                hour: 8,
                minute: 0,
              },
            },
          }),
        ),
      WorkflowDraftValidationError,
    );
  });

  it('rejects about:blank, forbidden schemes, and userinfo URLs', () => {
    for (const url of [
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///tmp/x',
      'blob:https://example.test/1',
      'chrome://settings',
      'chrome-extension://abc',
      'https://user:pass@example.com/',
    ]) {
      assert.throws(
        () => parseWorkflowDraft(validManual({ entryPoint: { kind: 'url', url } })),
        WorkflowDraftValidationError,
        url,
      );
    }
  });

  it('preserves query and fragment on valid URLs', () => {
    const draft = parseWorkflowDraft(
      validManual({
        entryPoint: { kind: 'url', url: 'https://example.test/status?site=1#outages' },
      }),
    );
    assert.equal(draft.entryPoint.url, 'https://example.test/status?site=1#outages');
  });

  it('rejects invalid one-time instants and natural-language dates', () => {
    for (const runAtUtc of ['tomorrow at 08:00', 'next Friday', 'not-a-date', '']) {
      assert.throws(
        () =>
          parseWorkflowDraft(
            validManual({
              trigger: { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc } },
            }),
          ),
        WorkflowDraftValidationError,
        runAtUtc,
      );
    }
  });

  it('rejects unknown timezones, hour/minute bounds, and invalid weekly days', () => {
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-daily',
                timeZone: 'Not/AZone',
                hour: 8,
                minute: 0,
              },
            },
          }),
        ),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-daily',
                timeZone: 'UTC',
                hour: 24,
                minute: 0,
              },
            },
          }),
        ),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-daily',
                timeZone: 'UTC',
                hour: 8,
                minute: 60,
              },
            },
          }),
        ),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-weekly',
                timeZone: 'UTC',
                hour: 8,
                minute: 0,
                daysOfWeek: [],
              },
            },
          }),
        ),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-weekly',
                timeZone: 'UTC',
                hour: 8,
                minute: 0,
                daysOfWeek: [1, 1],
              },
            },
          }),
        ),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: {
              kind: 'schedule',
              schedule: {
                kind: 'recurring-weekly',
                timeZone: 'UTC',
                hour: 8,
                minute: 0,
                daysOfWeek: [0, 8],
              },
            },
          }),
        ),
      WorkflowDraftValidationError,
    );
  });

  it('rejects cron, RRULE, and hourly schedule kinds without falling back to manual', () => {
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: { kind: 'schedule', schedule: { kind: 'cron', expression: '0 8 * * *' } },
          }),
        ),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: { kind: 'schedule', schedule: { kind: 'hourly' } },
          }),
        ),
      WorkflowDraftValidationError,
    );
    assert.throws(
      () =>
        parseWorkflowDraft(
          validManual({
            trigger: { kind: 'schedule', schedule: { kind: 'rrule', rrule: 'FREQ=DAILY' } },
          }),
        ),
      WorkflowDraftValidationError,
    );
  });
});
