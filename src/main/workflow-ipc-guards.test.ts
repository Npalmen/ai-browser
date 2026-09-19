import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  parseWorkflowCreateRequest,
  parseWorkflowEditRequest,
  parseWorkflowIdRequest,
  parseWorkflowOccurrenceActionRequest,
  parseWorkflowSetEnabledRequest,
} from './workflow-ipc-guards';

const ROOT = path.resolve(__dirname, '..', '..');

function validCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Invoice check',
    objective: 'Summarize the invoice.',
    entryPoint: { kind: 'url', url: 'https://example.test/path?resource=1' },
    trigger: { kind: 'manual' },
    ...overrides,
  };
}

describe('workflow IPC guards', () => {
  it('accepts structured create input and rejects renderer-owned identity fields', () => {
    const parsed = parseWorkflowCreateRequest(validCreate({ enabled: true }));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.input.entryPoint.url, 'https://example.test/path?resource=1');
      assert.equal(parsed.input.enabled, true);
      assert.equal('workflowId' in parsed.input, false);
      assert.equal('reviewRequired' in parsed.input, false);
      assert.equal('definitionRevision' in parsed.input, false);
    }
    assert.equal(parseWorkflowCreateRequest(validCreate({ workflowId: 'wf-injected' })).ok, false);
    assert.equal(parseWorkflowCreateRequest(validCreate({ reviewRequired: false })).ok, false);
    assert.equal(parseWorkflowCreateRequest(validCreate({ definitionRevision: 1 })).ok, false);
  });

  it('rejects cron, natural-language, and extra trigger keys', () => {
    assert.equal(
      parseWorkflowCreateRequest(validCreate({ trigger: { cron: '0 9 * * *' } })).ok,
      false,
    );
    assert.equal(parseWorkflowCreateRequest(validCreate({ trigger: 'every day' })).ok, false);
    assert.equal(
      parseWorkflowCreateRequest(validCreate({ trigger: { kind: 'manual', cron: '0 * * * *' } })).ok,
      false,
    );
  });

  it('rejects authority fields instead of dropping them', () => {
    for (const extra of [
      { tabId: 'tab-1' },
      { taskId: 'task-1' },
      { approvalId: 'appr-1' },
      { targetId: 'target-1' },
      { triggerKey: 'manual:x' },
      { ownerRuntimeSessionId: 'session-1' },
    ]) {
      assert.equal(parseWorkflowCreateRequest(validCreate(extra)).ok, false, JSON.stringify(extra));
      assert.equal(parseWorkflowIdRequest({ workflowId: 'wf-1', ...extra }).ok, false, JSON.stringify(extra));
    }
  });

  it('rejects edit payloads that try to clear reviewRequired', () => {
    assert.equal(
      parseWorkflowEditRequest({
        workflowId: 'wf-1',
        name: 'Name',
        objective: 'Objective',
        entryPoint: { kind: 'url', url: 'https://example.test/a' },
        trigger: { kind: 'manual' },
        reviewRequired: false,
      }).ok,
      false,
    );
    const parsed = parseWorkflowEditRequest({
      workflowId: 'wf-1',
      name: 'Name',
      objective: 'Objective',
      entryPoint: { kind: 'url', url: 'https://example.test/a' },
      trigger: { kind: 'manual' },
    });
    assert.equal(parsed.ok, true);
  });

  it('accepts structured schedules and canonicalizes one-time instants', () => {
    const oneTime = parseWorkflowCreateRequest(
      validCreate({
        trigger: {
          kind: 'schedule',
          schedule: { kind: 'one-time', runAtUtc: '2026-09-19T10:00:00.000Z' },
        },
      }),
    );
    assert.equal(oneTime.ok, true);
    if (oneTime.ok && oneTime.input.trigger.kind === 'schedule') {
      assert.equal(oneTime.input.trigger.schedule.kind, 'one-time');
      if (oneTime.input.trigger.schedule.kind === 'one-time') {
        assert.equal(oneTime.input.trigger.schedule.runAtUtc, '2026-09-19T10:00:00.000Z');
      }
    }
    const daily = parseWorkflowCreateRequest(
      validCreate({
        trigger: {
          kind: 'schedule',
          schedule: { kind: 'recurring-daily', timeZone: 'Europe/Stockholm', hour: 9, minute: 30 },
        },
      }),
    );
    assert.equal(daily.ok, true);
    const weekly = parseWorkflowCreateRequest(
      validCreate({
        trigger: {
          kind: 'schedule',
          schedule: {
            kind: 'recurring-weekly',
            timeZone: 'UTC',
            hour: 8,
            minute: 0,
            daysOfWeek: [1, 7],
          },
        },
      }),
    );
    assert.equal(weekly.ok, true);
    assert.equal(
      parseWorkflowCreateRequest(
        validCreate({
          trigger: {
            kind: 'schedule',
            schedule: { kind: 'recurring-daily', timeZone: 'Mars/Olympus_Mons', hour: 9, minute: 0 },
          },
        }),
      ).ok,
      false,
    );
    assert.equal(
      parseWorkflowCreateRequest(
        validCreate({
          trigger: {
            kind: 'schedule',
            schedule: { kind: 'recurring-weekly', timeZone: 'UTC', hour: 8, minute: 0, daysOfWeek: [1, 1] },
          },
        }),
      ).ok,
      false,
    );
  });

  it('rejects javascript and credentialed URLs while keeping valid query strings', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///tmp/x',
      'about:blank',
      'blob:https://example.test/1',
      'chrome://settings',
      'https://user:pass@example.test/',
    ]) {
      assert.equal(parseWorkflowCreateRequest(validCreate({ entryPoint: { kind: 'url', url } })).ok, false, url);
    }
  });

  it('validates enable and cancel inputs', () => {
    assert.equal(parseWorkflowSetEnabledRequest({ workflowId: 'wf-1', enabled: false }).ok, true);
    assert.equal(parseWorkflowSetEnabledRequest({ workflowId: 'wf-1', enabled: 'no' }).ok, false);
    assert.equal(
      parseWorkflowOccurrenceActionRequest({ workflowId: 'wf-1', occurrenceId: 'occ-1' }).ok,
      true,
    );
    assert.equal(
      parseWorkflowOccurrenceActionRequest({ workflowId: 'wf-1', occurrenceId: '../occ' }).ok,
      false,
    );
    assert.equal(parseWorkflowIdRequest({ workflowId: '' }).ok, false);
  });

  it('keeps workflow IPC free of filesystem, cron parsers, and generic invoke', () => {
    const guards = readFileSync(path.join(ROOT, 'src/main/workflow-ipc-guards.ts'), 'utf8');
    const ipc = readFileSync(path.join(ROOT, 'src/main/ipc.ts'), 'utf8');
    const preload = readFileSync(path.join(ROOT, 'src/preload/app-preload.ts'), 'utf8');
    for (const banned of ['readFile', 'writeFile', 'userData', 'invoke(channel', 'parseCron']) {
      assert.equal(guards.includes(banned), false, banned);
    }
    assert.equal(preload.includes('invoke(channel'), false);
    assert.equal(preload.includes('readFile'), false);
    assert.equal(preload.includes('writeFile'), false);
    assert.equal(preload.includes('userData'), false);
    const getState = ipc.slice(ipc.indexOf('WORKFLOW_IPC_CHANNELS.getState'), ipc.indexOf('WORKFLOW_IPC_CHANNELS.getDetail'));
    assert.equal(getState.includes('whenBrowserReady'), false);
    const create = ipc.slice(ipc.indexOf('WORKFLOW_IPC_CHANNELS.create'), ipc.indexOf('WORKFLOW_IPC_CHANNELS.edit'));
    assert.equal(create.includes('whenBrowserReady'), false);
    const runNow = ipc.slice(ipc.indexOf('WORKFLOW_IPC_CHANNELS.runNow'), ipc.indexOf('WORKFLOW_IPC_CHANNELS.acknowledgeReview'));
    assert.equal(runNow.includes('whenBrowserReady'), false);
  });
});
