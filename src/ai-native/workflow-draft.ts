import type { WorkflowDraft } from '../shared/ai-native-types';
import type { WorkflowProductTrigger } from '../shared/workflow-product-types';
import { parseWorkflowEntryUrl } from '../workflows/workflow-store-schema';
import {
  MAX_WORKFLOW_ENTRY_URL_CHARS,
  MAX_WORKFLOW_NAME_CHARS,
  MAX_WORKFLOW_OBJECTIVE_CHARS,
  MAX_WORKFLOW_TIMEZONE_CHARS,
} from '../workflows/workflow-store-types';
import { assertSupportedTimeZone, canonicalUtcInstant } from '../workflows/workflow-schedule';

export class WorkflowDraftValidationError extends Error {
  constructor(message = 'The generated workflow draft was invalid.') {
    super(message);
    this.name = 'WorkflowDraftValidationError';
  }
}

const DRAFT_KEYS = ['name', 'objective', 'entryPoint', 'trigger'] as const;
const ENTRY_POINT_KEYS = ['kind', 'url'] as const;
const MANUAL_TRIGGER_KEYS = ['kind'] as const;
const SCHEDULE_TRIGGER_KEYS = ['kind', 'schedule'] as const;
const ONE_TIME_KEYS = ['kind', 'runAtUtc'] as const;
const DAILY_KEYS = ['kind', 'timeZone', 'hour', 'minute'] as const;
const WEEKLY_KEYS = ['kind', 'timeZone', 'hour', 'minute', 'daysOfWeek'] as const;

const FORBIDDEN_DRAFT_FIELDS = new Set([
  'workflowId',
  'occurrenceId',
  'enabled',
  'reviewRequired',
  'definitionRevision',
  'triggerKey',
  'scheduledFor',
  'tabId',
  'taskId',
  'runId',
  'generation',
  'targetId',
  'observationId',
  'documentRevision',
  'approvalId',
  'preparedActionId',
  'executionId',
  'grant',
  'InteractionGrant',
  'ExecuteGrant',
  'cookies',
  'passwords',
  'OTP',
  'cardDetails',
  'pageText',
  'screenshots',
  'plannerTraces',
  'reasoning',
  'cron',
  'rrule',
  'runNow',
  'timeZone',
  'now',
]);

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const WORKFLOW_DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_WORKFLOW_NAME_CHARS },
    objective: { type: 'string', minLength: 1, maxLength: MAX_WORKFLOW_OBJECTIVE_CHARS },
    entryPoint: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'url' },
        url: { type: 'string', minLength: 1, maxLength: MAX_WORKFLOW_ENTRY_URL_CHARS },
      },
      required: ['kind', 'url'],
    },
    trigger: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { const: 'manual' },
          },
          required: ['kind'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { const: 'schedule' },
            schedule: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { const: 'one-time' },
                    runAtUtc: { type: 'string', minLength: 1 },
                  },
                  required: ['kind', 'runAtUtc'],
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { const: 'recurring-daily' },
                    timeZone: { type: 'string', minLength: 1, maxLength: MAX_WORKFLOW_TIMEZONE_CHARS },
                    hour: { type: 'integer', minimum: 0, maximum: 23 },
                    minute: { type: 'integer', minimum: 0, maximum: 59 },
                  },
                  required: ['kind', 'timeZone', 'hour', 'minute'],
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { const: 'recurring-weekly' },
                    timeZone: { type: 'string', minLength: 1, maxLength: MAX_WORKFLOW_TIMEZONE_CHARS },
                    hour: { type: 'integer', minimum: 0, maximum: 23 },
                    minute: { type: 'integer', minimum: 0, maximum: 59 },
                    daysOfWeek: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 7,
                      items: { type: 'integer', minimum: 1, maximum: 7 },
                    },
                  },
                  required: ['kind', 'timeZone', 'hour', 'minute', 'daysOfWeek'],
                },
              ],
            },
          },
          required: ['kind', 'schedule'],
        },
      ],
    },
  },
  required: ['name', 'objective', 'entryPoint', 'trigger'],
} as const;

export function parseWorkflowDraft(input: unknown): WorkflowDraft {
  const record = requirePlainObject(input);
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_DRAFT_FIELDS.has(key)) {
      throw new WorkflowDraftValidationError();
    }
  }
  assertExactKeys(record, DRAFT_KEYS);
  const name = parseBoundedText(record.name, MAX_WORKFLOW_NAME_CHARS);
  const objective = parseBoundedText(record.objective, MAX_WORKFLOW_OBJECTIVE_CHARS);
  const entryPoint = parseEntryPoint(record.entryPoint);
  const trigger = parseTrigger(record.trigger);
  return Object.freeze({
    name,
    objective,
    entryPoint,
    trigger,
  });
}

function parseEntryPoint(value: unknown): WorkflowDraft['entryPoint'] {
  const record = requirePlainObject(value);
  assertExactKeys(record, ENTRY_POINT_KEYS);
  if (record.kind !== 'url') {
    throw new WorkflowDraftValidationError();
  }
  try {
    return Object.freeze({
      kind: 'url' as const,
      url: parseWorkflowEntryUrl(record.url, 'WORKFLOW_STORE_MUTATION_INVALID'),
    });
  } catch {
    throw new WorkflowDraftValidationError();
  }
}

function parseTrigger(value: unknown): WorkflowProductTrigger {
  const record = requirePlainObject(value);
  if (record.kind === 'manual') {
    assertExactKeys(record, MANUAL_TRIGGER_KEYS);
    return Object.freeze({ kind: 'manual' });
  }
  if (record.kind !== 'schedule') {
    throw new WorkflowDraftValidationError();
  }
  assertExactKeys(record, SCHEDULE_TRIGGER_KEYS);
  return Object.freeze({ kind: 'schedule', schedule: parseSchedule(record.schedule) });
}

function parseSchedule(value: unknown): Extract<WorkflowProductTrigger, { kind: 'schedule' }>['schedule'] {
  const record = requirePlainObject(value);
  if (record.kind === 'one-time') {
    assertExactKeys(record, ONE_TIME_KEYS);
    return Object.freeze({
      kind: 'one-time',
      runAtUtc: parseOneTimeInstant(record.runAtUtc),
    });
  }
  if (record.kind === 'recurring-daily') {
    assertExactKeys(record, DAILY_KEYS);
    return Object.freeze({
      kind: 'recurring-daily',
      timeZone: parseTimeZone(record.timeZone),
      hour: parseHour(record.hour),
      minute: parseMinute(record.minute),
    });
  }
  if (record.kind === 'recurring-weekly') {
    assertExactKeys(record, WEEKLY_KEYS);
    return Object.freeze({
      kind: 'recurring-weekly',
      timeZone: parseTimeZone(record.timeZone),
      hour: parseHour(record.hour),
      minute: parseMinute(record.minute),
      daysOfWeek: parseDaysOfWeek(record.daysOfWeek),
    });
  }
  throw new WorkflowDraftValidationError();
}

function parseOneTimeInstant(value: unknown): string {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
    throw new WorkflowDraftValidationError();
  }
  try {
    return canonicalUtcInstant(value);
  } catch {
    throw new WorkflowDraftValidationError();
  }
}

function parseTimeZone(value: unknown): string {
  const timeZone = parseBoundedText(value, MAX_WORKFLOW_TIMEZONE_CHARS);
  try {
    assertSupportedTimeZone(timeZone);
  } catch {
    throw new WorkflowDraftValidationError();
  }
  return timeZone;
}

function parseHour(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 23) {
    throw new WorkflowDraftValidationError();
  }
  return value as number;
}

function parseMinute(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 59) {
    throw new WorkflowDraftValidationError();
  }
  return value as number;
}

function parseDaysOfWeek(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkflowDraftValidationError();
  }
  const days: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (!Number.isInteger(item) || item < 1 || item > 7 || seen.has(item)) {
      throw new WorkflowDraftValidationError();
    }
    seen.add(item);
    days.push(item);
  }
  return Object.freeze(days);
}

function parseBoundedText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new WorkflowDraftValidationError();
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    throw new WorkflowDraftValidationError();
  }
  return trimmed;
}

function requirePlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowDraftValidationError();
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size) {
    throw new WorkflowDraftValidationError();
  }
  for (const key of actual) {
    if (!expected.has(key)) {
      throw new WorkflowDraftValidationError();
    }
  }
}
