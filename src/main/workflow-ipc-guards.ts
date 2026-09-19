import type {
  WorkflowCreateInput,
  WorkflowEditInput,
  WorkflowIdInput,
  WorkflowOccurrenceActionInput,
  WorkflowProductEntryPoint,
  WorkflowProductError,
  WorkflowProductTrigger,
  WorkflowSetEnabledInput,
} from '../shared/workflow-product-types';
import { parseWorkflowEntryUrl } from '../workflows/workflow-store-schema';
import {
  MAX_OCCURRENCE_ID_CHARS,
  MAX_WORKFLOW_ID_CHARS,
  MAX_WORKFLOW_NAME_CHARS,
  MAX_WORKFLOW_OBJECTIVE_CHARS,
  MAX_WORKFLOW_TIMEZONE_CHARS,
} from '../workflows/workflow-store-types';
import { assertSupportedTimeZone, canonicalUtcInstant } from '../workflows/workflow-schedule';
import { workflowProductError } from './workflow-product-safe-error';

const CREATE_ALLOWED = ['name', 'objective', 'entryPoint', 'trigger', 'enabled'] as const;
const CREATE_REQUIRED = ['name', 'objective', 'entryPoint', 'trigger'] as const;
const EDIT_KEYS = ['workflowId', 'name', 'objective', 'entryPoint', 'trigger'] as const;
const ID_KEYS = ['workflowId'] as const;
const ENABLED_KEYS = ['workflowId', 'enabled'] as const;
const OCCURRENCE_ACTION_KEYS = ['workflowId', 'occurrenceId'] as const;
const ENTRY_POINT_KEYS = ['kind', 'url'] as const;
const MANUAL_TRIGGER_KEYS = ['kind'] as const;
const SCHEDULE_TRIGGER_KEYS = ['kind', 'schedule'] as const;
const ONE_TIME_KEYS = ['kind', 'runAtUtc'] as const;
const DAILY_KEYS = ['kind', 'timeZone', 'hour', 'minute'] as const;
const WEEKLY_KEYS = ['kind', 'timeZone', 'hour', 'minute', 'daysOfWeek'] as const;

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  'tabId',
  'taskId',
  'AgentRunRef',
  'targetId',
  'observationId',
  'documentRevision',
  'approvalId',
  'preparedActionId',
  'executionId',
  'InteractionGrant',
  'ExecuteGrant',
  'runtimeSessionId',
  'ownerRuntimeSessionId',
  'triggerKey',
  'generation',
  'runId',
  'grant',
  'authority',
  'reviewRequired',
  'definitionRevision',
  'createdAt',
  'updatedAt',
  'cron',
  'rrule',
]);

export function parseWorkflowIdRequest(
  input: unknown,
): { ok: true; input: WorkflowIdInput } | { ok: false; error: WorkflowProductError } {
  const record = parseObject(input, ID_KEYS, ID_KEYS);
  if (!record.ok) {
    return record;
  }
  const workflowId = parseCorrelationId(record.value.workflowId, MAX_WORKFLOW_ID_CHARS);
  if (workflowId === undefined) {
    return invalid();
  }
  return { ok: true, input: Object.freeze({ workflowId }) };
}

export function parseWorkflowSetEnabledRequest(
  input: unknown,
): { ok: true; input: WorkflowSetEnabledInput } | { ok: false; error: WorkflowProductError } {
  const record = parseObject(input, ENABLED_KEYS, ENABLED_KEYS);
  if (!record.ok) {
    return record;
  }
  const workflowId = parseCorrelationId(record.value.workflowId, MAX_WORKFLOW_ID_CHARS);
  if (workflowId === undefined || typeof record.value.enabled !== 'boolean') {
    return invalid();
  }
  return { ok: true, input: Object.freeze({ workflowId, enabled: record.value.enabled }) };
}

export function parseWorkflowOccurrenceActionRequest(
  input: unknown,
): { ok: true; input: WorkflowOccurrenceActionInput } | { ok: false; error: WorkflowProductError } {
  const record = parseObject(input, OCCURRENCE_ACTION_KEYS, OCCURRENCE_ACTION_KEYS);
  if (!record.ok) {
    return record;
  }
  const workflowId = parseCorrelationId(record.value.workflowId, MAX_WORKFLOW_ID_CHARS);
  const occurrenceId = parseCorrelationId(record.value.occurrenceId, MAX_OCCURRENCE_ID_CHARS);
  if (workflowId === undefined || occurrenceId === undefined) {
    return invalid();
  }
  return { ok: true, input: Object.freeze({ workflowId, occurrenceId }) };
}

export function parseWorkflowCreateRequest(
  input: unknown,
): { ok: true; input: WorkflowCreateInput } | { ok: false; error: WorkflowProductError } {
  const record = parseObject(input, CREATE_ALLOWED, CREATE_REQUIRED);
  if (!record.ok) {
    return record;
  }
  const name = parseBoundedText(record.value.name, MAX_WORKFLOW_NAME_CHARS);
  const objective = parseBoundedText(record.value.objective, MAX_WORKFLOW_OBJECTIVE_CHARS);
  const entryPoint = parseEntryPoint(record.value.entryPoint);
  const trigger = parseTrigger(record.value.trigger);
  if (name === undefined || objective === undefined || entryPoint === undefined || trigger === undefined) {
    return invalid();
  }
  if (record.value.enabled !== undefined && typeof record.value.enabled !== 'boolean') {
    return invalid();
  }
  const created: WorkflowCreateInput = {
    name,
    objective,
    entryPoint,
    trigger,
  };
  if (typeof record.value.enabled === 'boolean') {
    return { ok: true, input: Object.freeze({ ...created, enabled: record.value.enabled }) };
  }
  return { ok: true, input: Object.freeze(created) };
}

export function parseWorkflowEditRequest(
  input: unknown,
): { ok: true; input: WorkflowEditInput } | { ok: false; error: WorkflowProductError } {
  const record = parseObject(input, EDIT_KEYS, EDIT_KEYS);
  if (!record.ok) {
    return record;
  }
  const workflowId = parseCorrelationId(record.value.workflowId, MAX_WORKFLOW_ID_CHARS);
  const name = parseBoundedText(record.value.name, MAX_WORKFLOW_NAME_CHARS);
  const objective = parseBoundedText(record.value.objective, MAX_WORKFLOW_OBJECTIVE_CHARS);
  const entryPoint = parseEntryPoint(record.value.entryPoint);
  const trigger = parseTrigger(record.value.trigger);
  if (
    workflowId === undefined ||
    name === undefined ||
    objective === undefined ||
    entryPoint === undefined ||
    trigger === undefined
  ) {
    return invalid();
  }
  return {
    ok: true,
    input: Object.freeze({ workflowId, name, objective, entryPoint, trigger }),
  };
}

function parseEntryPoint(value: unknown): WorkflowProductEntryPoint | undefined {
  const record = parseExactRecord(value, ENTRY_POINT_KEYS);
  if (!record || record.kind !== 'url') {
    return undefined;
  }
  try {
    const url = parseWorkflowEntryUrl(record.url, 'WORKFLOW_STORE_MUTATION_INVALID');
    return Object.freeze({ kind: 'url', url });
  } catch {
    return undefined;
  }
}

function parseTrigger(value: unknown): WorkflowProductTrigger | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (FORBIDDEN_AUTHORITY_FIELDS.has('cron') && Object.prototype.hasOwnProperty.call(record, 'cron')) {
    return undefined;
  }
  if (record.kind === 'manual') {
    if (!exactKeys(record, MANUAL_TRIGGER_KEYS)) {
      return undefined;
    }
    return Object.freeze({ kind: 'manual' });
  }
  if (record.kind !== 'schedule' || !exactKeys(record, SCHEDULE_TRIGGER_KEYS)) {
    return undefined;
  }
  const schedule = parseSchedule(record.schedule);
  if (schedule === undefined) {
    return undefined;
  }
  return Object.freeze({ kind: 'schedule', schedule });
}

function parseSchedule(value: unknown): WorkflowProductTrigger extends { kind: 'schedule' }
  ? WorkflowProductTrigger['schedule'] | undefined
  : never {
  const record = parsePlain(value);
  if (!record || typeof record.kind !== 'string') {
    return undefined as never;
  }
  if (record.kind === 'one-time') {
    if (!exactKeys(record, ONE_TIME_KEYS) || typeof record.runAtUtc !== 'string') {
      return undefined as never;
    }
    try {
      return Object.freeze({
        kind: 'one-time',
        runAtUtc: canonicalUtcInstant(record.runAtUtc),
      }) as never;
    } catch {
      return undefined as never;
    }
  }
  if (record.kind === 'recurring-daily') {
    if (!exactKeys(record, DAILY_KEYS)) {
      return undefined as never;
    }
    const timeZone = parseTimeZone(record.timeZone);
    const hour = parseHour(record.hour);
    const minute = parseMinute(record.minute);
    if (timeZone === undefined || hour === undefined || minute === undefined) {
      return undefined as never;
    }
    return Object.freeze({ kind: 'recurring-daily', timeZone, hour, minute }) as never;
  }
  if (record.kind === 'recurring-weekly') {
    if (!exactKeys(record, WEEKLY_KEYS)) {
      return undefined as never;
    }
    const timeZone = parseTimeZone(record.timeZone);
    const hour = parseHour(record.hour);
    const minute = parseMinute(record.minute);
    const daysOfWeek = parseDaysOfWeek(record.daysOfWeek);
    if (
      timeZone === undefined ||
      hour === undefined ||
      minute === undefined ||
      daysOfWeek === undefined
    ) {
      return undefined as never;
    }
    return Object.freeze({ kind: 'recurring-weekly', timeZone, hour, minute, daysOfWeek }) as never;
  }
  return undefined as never;
}

function parseTimeZone(value: unknown): string | undefined {
  const timeZone = parseBoundedText(value, MAX_WORKFLOW_TIMEZONE_CHARS);
  if (timeZone === undefined) {
    return undefined;
  }
  try {
    assertSupportedTimeZone(timeZone);
    return timeZone;
  } catch {
    return undefined;
  }
}

function parseHour(value: unknown): number | undefined {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 23) {
    return undefined;
  }
  return value as number;
}

function parseMinute(value: unknown): number | undefined {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 59) {
    return undefined;
  }
  return value as number;
}

function parseDaysOfWeek(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const days: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (!Number.isInteger(item) || item < 1 || item > 7 || seen.has(item)) {
      return undefined;
    }
    seen.add(item);
    days.push(item);
  }
  return Object.freeze(days);
}

function parseCorrelationId(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return undefined;
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return undefined;
  }
  return trimmed;
}

function parseBoundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return undefined;
  }
  return trimmed;
}

function parseObject(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
): { ok: true; value: Record<string, unknown> } | { ok: false; error: WorkflowProductError } {
  const record = parsePlain(input);
  if (!record) {
    return invalid();
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key) || FORBIDDEN_AUTHORITY_FIELDS.has(key)) {
      return invalid();
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return invalid();
    }
  }
  return { ok: true, value: record };
}

function parseExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const record = parsePlain(value);
  if (!record || !exactKeys(record, keys)) {
    return undefined;
  }
  return record;
}

function parsePlain(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== expected.size) {
    return false;
  }
  return actual.every((key) => expected.has(key) && !FORBIDDEN_AUTHORITY_FIELDS.has(key));
}

function invalid(): { ok: false; error: WorkflowProductError } {
  return { ok: false, error: workflowProductError('WORKFLOW_INVALID_REQUEST') };
}
