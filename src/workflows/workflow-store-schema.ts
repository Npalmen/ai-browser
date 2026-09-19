import { WorkflowStoreError } from './workflow-store-errors';
import {
  MAX_OCCURRENCE_ID_CHARS,
  MAX_RUNTIME_SESSION_ID_CHARS,
  MAX_TERMINAL_REASON_CHARS,
  MAX_TRIGGER_KEY_CHARS,
  MAX_WORKFLOW_ENTRY_URL_CHARS,
  MAX_WORKFLOW_FINAL_ANSWER_CHARS,
  MAX_WORKFLOW_ID_CHARS,
  MAX_WORKFLOW_NAME_CHARS,
  MAX_WORKFLOW_OBJECTIVE_CHARS,
  MAX_WORKFLOW_TIMEZONE_CHARS,
  TERMINAL_WORKFLOW_OCCURRENCE_STATES,
  WORKFLOW_DEFINITION_KEYS,
  WORKFLOW_OCCURRENCE_KEYS,
  WORKFLOW_OCCURRENCE_STATES,
  WORKFLOW_STORE_SCHEMA_VERSION,
  WORKFLOW_STORE_TOP_LEVEL_KEYS,
  type DurableWorkflowDefinitionRecord,
  type WorkflowOccurrenceFrozenDefinitionRecord,
  type WorkflowOccurrenceRecord,
  type WorkflowOccurrenceState,
  type WorkflowScheduleRecord,
  type WorkflowStorePayload,
  type WorkflowStoreSnapshot,
  type WorkflowTriggerRecord,
  type WorkflowUrlEntryPointRecord,
} from './workflow-store-types';

const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TIME_ZONE_PATTERN = /^[A-Za-z0-9_+\-/]+$/;

const ENTRY_POINT_KEYS = new Set(['kind', 'url']);
const MANUAL_TRIGGER_KEYS = new Set(['kind']);
const SCHEDULE_TRIGGER_KEYS = new Set(['kind', 'schedule']);
const ONE_TIME_SCHEDULE_KEYS = new Set(['kind', 'runAtUtc']);
const DAILY_SCHEDULE_KEYS = new Set(['kind', 'timeZone', 'hour', 'minute']);
const WEEKLY_SCHEDULE_KEYS = new Set(['kind', 'timeZone', 'hour', 'minute', 'daysOfWeek']);
const FROZEN_DEFINITION_KEYS = new Set(['objective', 'entryPoint', 'trigger']);
const PAYLOAD_KEYS = new Set(['workflows', 'occurrences']);
const TERMINAL_STATE_SET = new Set<string>(TERMINAL_WORKFLOW_OCCURRENCE_STATES);
const OCCURRENCE_STATE_SET = new Set<string>(WORKFLOW_OCCURRENCE_STATES);

export function parseWorkflowStoreJson(
  text: string,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID' = 'WORKFLOW_STORE_CORRUPT',
): WorkflowStoreSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid(invalidCode, 'Workflow store is not valid JSON.');
  }
  return parseWorkflowStoreSnapshot(parsed, invalidCode);
}

export function parseWorkflowStoreSnapshot(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID' = 'WORKFLOW_STORE_CORRUPT',
): WorkflowStoreSnapshot {
  const record = requirePlainObject(value, invalidCode, 'Workflow store snapshot');
  throwIfUnsupportedSchema(record);
  assertExactKeys(record, WORKFLOW_STORE_TOP_LEVEL_KEYS, invalidCode, 'Workflow store snapshot');

  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== WORKFLOW_STORE_SCHEMA_VERSION) {
    throw invalid(invalidCode, 'Workflow store schemaVersion is invalid.');
  }

  const storeRevision = requireNonNegativeInteger(record.storeRevision, invalidCode, 'storeRevision');
  const workflows = parseWorkflowList(record.workflows, invalidCode);
  const occurrences = parseOccurrenceList(record.occurrences, invalidCode);
  assertReferentialIntegrity(workflows, occurrences, invalidCode);

  return {
    schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
    storeRevision,
    workflows,
    occurrences,
  };
}

export function parseWorkflowStorePayload(
  value: unknown,
): WorkflowStorePayload {
  const invalidCode = 'WORKFLOW_STORE_MUTATION_INVALID';
  const record = requirePlainObject(value, invalidCode, 'Workflow store payload');
  assertExactKeys(record, PAYLOAD_KEYS, invalidCode, 'Workflow store payload');
  const workflows = parseWorkflowList(record.workflows, invalidCode);
  const occurrences = parseOccurrenceList(record.occurrences, invalidCode);
  assertReferentialIntegrity(workflows, occurrences, invalidCode);
  return { workflows, occurrences };
}

export function serializeWorkflowStoreSnapshot(snapshot: WorkflowStoreSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function cloneWorkflowStoreSnapshot(snapshot: WorkflowStoreSnapshot): WorkflowStoreSnapshot {
  return freezeDeep(parseWorkflowStoreSnapshot(structuredClone(snapshot)));
}

function parseWorkflowList(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): DurableWorkflowDefinitionRecord[] {
  if (!Array.isArray(value)) {
    throw invalid(invalidCode, 'Workflow list is invalid.');
  }
  const workflows: DurableWorkflowDefinitionRecord[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const workflow = parseWorkflow(item, invalidCode);
    if (seen.has(workflow.workflowId)) {
      throw invalid(invalidCode, 'Duplicate workflowId.');
    }
    seen.add(workflow.workflowId);
    workflows.push(workflow);
  }
  return workflows;
}

function parseOccurrenceList(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): WorkflowOccurrenceRecord[] {
  if (!Array.isArray(value)) {
    throw invalid(invalidCode, 'Occurrence list is invalid.');
  }
  const occurrences: WorkflowOccurrenceRecord[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const item of value) {
    const occurrence = parseOccurrence(item, invalidCode);
    if (seenIds.has(occurrence.occurrenceId)) {
      throw invalid(invalidCode, 'Duplicate occurrenceId.');
    }
    if (seenKeys.has(occurrence.triggerKey)) {
      throw invalid(invalidCode, 'Duplicate triggerKey.');
    }
    seenIds.add(occurrence.occurrenceId);
    seenKeys.add(occurrence.triggerKey);
    occurrences.push(occurrence);
  }
  return occurrences;
}

function parseWorkflow(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): DurableWorkflowDefinitionRecord {
  const record = requirePlainObject(value, invalidCode, 'Workflow definition');
  assertExactKeys(record, WORKFLOW_DEFINITION_KEYS, invalidCode, 'Workflow definition');
  return {
    workflowId: requireBoundedId(record.workflowId, MAX_WORKFLOW_ID_CHARS, invalidCode, 'workflowId'),
    definitionRevision: requirePositiveInteger(record.definitionRevision, invalidCode, 'definitionRevision'),
    name: requireBoundedText(record.name, MAX_WORKFLOW_NAME_CHARS, invalidCode, 'name'),
    objective: requireBoundedText(record.objective, MAX_WORKFLOW_OBJECTIVE_CHARS, invalidCode, 'objective'),
    entryPoint: parseEntryPoint(record.entryPoint, invalidCode),
    trigger: parseTrigger(record.trigger, invalidCode),
    enabled: requireBoolean(record.enabled, invalidCode, 'enabled'),
    reviewRequired: requireBoolean(record.reviewRequired, invalidCode, 'reviewRequired'),
    createdAt: requireUtcInstant(record.createdAt, invalidCode, 'createdAt'),
    updatedAt: requireUtcInstant(record.updatedAt, invalidCode, 'updatedAt'),
  };
}

function parseOccurrence(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): WorkflowOccurrenceRecord {
  const record = requirePlainObject(value, invalidCode, 'Workflow occurrence');
  assertExactKeys(record, WORKFLOW_OCCURRENCE_KEYS, invalidCode, 'Workflow occurrence');
  const state = parseOccurrenceState(record.state, invalidCode);
  const occurrence: WorkflowOccurrenceRecord = {
    occurrenceId: requireBoundedId(record.occurrenceId, MAX_OCCURRENCE_ID_CHARS, invalidCode, 'occurrenceId'),
    workflowId: requireBoundedId(record.workflowId, MAX_WORKFLOW_ID_CHARS, invalidCode, 'workflowId'),
    definitionRevision: requirePositiveInteger(record.definitionRevision, invalidCode, 'definitionRevision'),
    triggerKey: requireBoundedId(record.triggerKey, MAX_TRIGGER_KEY_CHARS, invalidCode, 'triggerKey'),
    scheduledFor: requireNullableUtcInstant(record.scheduledFor, invalidCode, 'scheduledFor'),
    frozenDefinition: parseFrozenDefinition(record.frozenDefinition, invalidCode),
    state,
    createdAt: requireUtcInstant(record.createdAt, invalidCode, 'createdAt'),
    startedAt: requireNullableUtcInstant(record.startedAt, invalidCode, 'startedAt'),
    finishedAt: requireNullableUtcInstant(record.finishedAt, invalidCode, 'finishedAt'),
    ownerRuntimeSessionId: requireNullableBoundedId(
      record.ownerRuntimeSessionId,
      MAX_RUNTIME_SESSION_ID_CHARS,
      invalidCode,
      'ownerRuntimeSessionId',
    ),
    terminalReason: requireNullableBoundedText(
      record.terminalReason,
      MAX_TERMINAL_REASON_CHARS,
      invalidCode,
      'terminalReason',
    ),
    finalAnswer: requireNullableBoundedText(
      record.finalAnswer,
      MAX_WORKFLOW_FINAL_ANSWER_CHARS,
      invalidCode,
      'finalAnswer',
    ),
  };
  assertOccurrenceStateConsistency(occurrence, invalidCode);
  return occurrence;
}

function parseFrozenDefinition(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): WorkflowOccurrenceFrozenDefinitionRecord {
  const record = requirePlainObject(value, invalidCode, 'Frozen workflow definition');
  assertExactKeys(record, FROZEN_DEFINITION_KEYS, invalidCode, 'Frozen workflow definition');
  return {
    objective: requireBoundedText(record.objective, MAX_WORKFLOW_OBJECTIVE_CHARS, invalidCode, 'objective'),
    entryPoint: parseEntryPoint(record.entryPoint, invalidCode),
    trigger: parseTrigger(record.trigger, invalidCode),
  };
}

function parseEntryPoint(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): WorkflowUrlEntryPointRecord {
  const record = requirePlainObject(value, invalidCode, 'Entry point');
  assertExactKeys(record, ENTRY_POINT_KEYS, invalidCode, 'Entry point');
  if (record.kind !== 'url') {
    throw invalid(invalidCode, 'Entry point kind is invalid.');
  }
  return {
    kind: 'url',
    url: parseWorkflowEntryUrl(record.url, invalidCode),
  };
}

export function parseWorkflowEntryUrl(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID' = 'WORKFLOW_STORE_CORRUPT',
): string {
  if (typeof value !== 'string') {
    throw invalid(invalidCode, 'Entry URL is invalid.');
  }
  if (value.length === 0 || value.length > MAX_WORKFLOW_ENTRY_URL_CHARS) {
    throw invalid(invalidCode, 'Entry URL is invalid.');
  }
  if (value.trim() !== value) {
    throw invalid(invalidCode, 'Entry URL is invalid.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid(invalidCode, 'Entry URL is invalid.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid(invalidCode, 'Entry URL is invalid.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalid(invalidCode, 'Entry URL is invalid.');
  }

  return value;
}

function parseTrigger(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): WorkflowTriggerRecord {
  const record = requirePlainObject(value, invalidCode, 'Trigger');
  if (record.kind === 'manual') {
    assertExactKeys(record, MANUAL_TRIGGER_KEYS, invalidCode, 'Manual trigger');
    return { kind: 'manual' };
  }
  if (record.kind === 'schedule') {
    assertExactKeys(record, SCHEDULE_TRIGGER_KEYS, invalidCode, 'Schedule trigger');
    return { kind: 'schedule', schedule: parseSchedule(record.schedule, invalidCode) };
  }
  throw invalid(invalidCode, 'Trigger kind is invalid.');
}

function parseSchedule(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): WorkflowScheduleRecord {
  const record = requirePlainObject(value, invalidCode, 'Schedule');
  if (record.kind === 'one-time') {
    assertExactKeys(record, ONE_TIME_SCHEDULE_KEYS, invalidCode, 'One-time schedule');
    return {
      kind: 'one-time',
      runAtUtc: requireUtcInstant(record.runAtUtc, invalidCode, 'runAtUtc'),
    };
  }
  if (record.kind === 'recurring-daily') {
    assertExactKeys(record, DAILY_SCHEDULE_KEYS, invalidCode, 'Daily schedule');
    return {
      kind: 'recurring-daily',
      timeZone: requireTimeZone(record.timeZone, invalidCode),
      hour: requireHour(record.hour, invalidCode),
      minute: requireMinute(record.minute, invalidCode),
    };
  }
  if (record.kind === 'recurring-weekly') {
    assertExactKeys(record, WEEKLY_SCHEDULE_KEYS, invalidCode, 'Weekly schedule');
    return {
      kind: 'recurring-weekly',
      timeZone: requireTimeZone(record.timeZone, invalidCode),
      hour: requireHour(record.hour, invalidCode),
      minute: requireMinute(record.minute, invalidCode),
      daysOfWeek: parseDaysOfWeek(record.daysOfWeek, invalidCode),
    };
  }
  throw invalid(invalidCode, 'Schedule kind is invalid.');
}

function parseDaysOfWeek(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(invalidCode, 'daysOfWeek is invalid.');
  }
  const days: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (!Number.isInteger(item) || item < 1 || item > 7) {
      throw invalid(invalidCode, 'daysOfWeek is invalid.');
    }
    if (seen.has(item)) {
      throw invalid(invalidCode, 'daysOfWeek is invalid.');
    }
    seen.add(item);
    days.push(item);
  }
  return days;
}

function parseOccurrenceState(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): WorkflowOccurrenceState {
  if (typeof value !== 'string' || !OCCURRENCE_STATE_SET.has(value)) {
    throw invalid(invalidCode, 'Occurrence state is invalid.');
  }
  return value as WorkflowOccurrenceState;
}

function assertOccurrenceStateConsistency(
  occurrence: WorkflowOccurrenceRecord,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): void {
  if (occurrence.state === 'queued') {
    if (
      occurrence.startedAt !== null ||
      occurrence.finishedAt !== null ||
      occurrence.ownerRuntimeSessionId !== null ||
      occurrence.finalAnswer !== null ||
      occurrence.terminalReason !== null
    ) {
      throw invalid(invalidCode, 'Queued occurrence fields are inconsistent.');
    }
    return;
  }

  if (occurrence.state === 'running') {
    if (
      occurrence.startedAt === null ||
      occurrence.finishedAt !== null ||
      occurrence.ownerRuntimeSessionId === null ||
      occurrence.finalAnswer !== null ||
      occurrence.terminalReason !== null
    ) {
      throw invalid(invalidCode, 'Running occurrence fields are inconsistent.');
    }
    return;
  }

  if (!TERMINAL_STATE_SET.has(occurrence.state)) {
    throw invalid(invalidCode, 'Occurrence state is invalid.');
  }
  if (occurrence.finishedAt === null || occurrence.ownerRuntimeSessionId !== null) {
    throw invalid(invalidCode, 'Terminal occurrence fields are inconsistent.');
  }
  if (occurrence.state !== 'completed' && occurrence.finalAnswer !== null) {
    throw invalid(invalidCode, 'Terminal occurrence fields are inconsistent.');
  }
}

function assertReferentialIntegrity(
  workflows: readonly DurableWorkflowDefinitionRecord[],
  occurrences: readonly WorkflowOccurrenceRecord[],
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): void {
  const workflowIds = new Set(workflows.map((workflow) => workflow.workflowId));
  for (const occurrence of occurrences) {
    if (!workflowIds.has(occurrence.workflowId)) {
      throw invalid(invalidCode, 'Occurrence workflowId is unknown.');
    }
  }
}

function throwIfUnsupportedSchema(record: Record<string, unknown>): void {
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) && schemaVersion !== 1) {
    throw new WorkflowStoreError(
      'WORKFLOW_STORE_SCHEMA_UNSUPPORTED',
      'Workflow store schema is unsupported.',
    );
  }
}

function requirePlainObject(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(invalidCode, `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[] | Set<string>,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  label: string,
): void {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw invalid(invalidCode, `${label} contains unknown fields.`);
    }
  }
  for (const key of allowedSet) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw invalid(invalidCode, `${label} is missing required fields.`);
    }
  }
}

function requireBoundedId(
  value: unknown,
  maxChars: number,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  _label: string,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars || value.trim() !== value) {
    throw invalid(invalidCode, 'Identifier is invalid.');
  }
  return value;
}

function requireNullableBoundedId(
  value: unknown,
  maxChars: number,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  label: string,
): string | null {
  if (value === null) {
    return null;
  }
  return requireBoundedId(value, maxChars, invalidCode, label);
}

function requireBoundedText(
  value: unknown,
  maxChars: number,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  _label: string,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw invalid(invalidCode, 'Text field is invalid.');
  }
  return value;
}

function requireNullableBoundedText(
  value: unknown,
  maxChars: number,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  _label: string,
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw invalid(invalidCode, 'Text field is invalid.');
  }
  return value;
}

function requireBoolean(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  _label: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw invalid(invalidCode, 'Boolean field is invalid.');
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  _label: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(invalidCode, 'Integer field is invalid.');
  }
  return value;
}

function requireNonNegativeInteger(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  _label: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(invalidCode, 'Integer field is invalid.');
  }
  return value;
}

function requireHour(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    throw invalid(invalidCode, 'Hour is invalid.');
  }
  return value;
}

function requireMinute(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 59) {
    throw invalid(invalidCode, 'Minute is invalid.');
  }
  return value;
}

function requireTimeZone(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WORKFLOW_TIMEZONE_CHARS ||
    !TIME_ZONE_PATTERN.test(value)
  ) {
    throw invalid(invalidCode, 'Time zone is invalid.');
  }
  return value;
}

function requireUtcInstant(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  _label: string,
): string {
  if (typeof value !== 'string' || !UTC_INSTANT_PATTERN.test(value)) {
    throw invalid(invalidCode, 'Timestamp is invalid.');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw invalid(invalidCode, 'Timestamp is invalid.');
  }
  return value;
}

function requireNullableUtcInstant(
  value: unknown,
  invalidCode: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  label: string,
): string | null {
  if (value === null) {
    return null;
  }
  return requireUtcInstant(value, invalidCode, label);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        freezeDeep(item);
      }
    } else {
      for (const nested of Object.values(value)) {
        freezeDeep(nested);
      }
    }
  }
  return value;
}

function invalid(
  code: 'WORKFLOW_STORE_CORRUPT' | 'WORKFLOW_STORE_MUTATION_INVALID',
  message: string,
): WorkflowStoreError {
  return new WorkflowStoreError(code, message);
}
