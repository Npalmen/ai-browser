import { MODEL_CONTEXT_BUDGETS } from '../ai/context-builder';
import {
  MAX_AUTONOMOUS_TASK_ID_CHARS,
  MAX_AUTONOMOUS_TASK_OBJECTIVE_CHARS,
  MAX_AUTONOMOUS_TASK_REPLY_CHARS,
  type AutonomousTaskIdInput,
  type AutonomousTaskReplyInput,
  type AutonomousTaskStartInput,
} from '../shared/autonomous-task-types';
import type { AiSafeError } from '../shared/ai-types';
import { aiSafeError } from './ai-safe-error';

const START_KEYS = new Set(['objective']);
const TASK_ID_KEYS = new Set(['taskId']);
const REPLY_KEYS = new Set(['taskId', 'reply']);

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  'generation',
  'approvalId',
  'preparedActionId',
  'executionId',
  'ExecuteGrant',
  'InteractionGrant',
  'runId',
  'AgentRunRef',
  'targetId',
  'observationId',
  'documentRevision',
  'backendDOMNodeId',
  'frameId',
  'tabId',
  'approved',
  'grant',
  'authority',
  'plannerLimit',
  'childRunLimit',
  'approvalLimit',
  'tabLimit',
]);

export function parseAutonomousTaskStartRequest(
  input: unknown,
): { ok: true; input: AutonomousTaskStartInput } | { ok: false; error: AiSafeError } {
  const record = parseExactObject(input, START_KEYS);
  if (!record.ok) {
    return record;
  }
  const objective = parseBoundedTrimmedString(
    record.value.objective,
    MAX_AUTONOMOUS_TASK_OBJECTIVE_CHARS,
  );
  if (objective === undefined) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  if (objective.length > MODEL_CONTEXT_BUDGETS.maxUserQuestionChars) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  return {
    ok: true,
    input: Object.freeze({ objective }),
  };
}

export function parseAutonomousTaskIdRequest(
  input: unknown,
): { ok: true; input: AutonomousTaskIdInput } | { ok: false; error: AiSafeError } {
  const record = parseExactObject(input, TASK_ID_KEYS);
  if (!record.ok) {
    return record;
  }
  const taskId = parseTaskId(record.value.taskId);
  if (taskId === undefined) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  return {
    ok: true,
    input: Object.freeze({ taskId }),
  };
}

export function parseAutonomousTaskReplyRequest(
  input: unknown,
): { ok: true; input: AutonomousTaskReplyInput } | { ok: false; error: AiSafeError } {
  const record = parseExactObject(input, REPLY_KEYS);
  if (!record.ok) {
    return record;
  }
  const taskId = parseTaskId(record.value.taskId);
  if (taskId === undefined) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  const reply = parseBoundedTrimmedString(record.value.reply, MAX_AUTONOMOUS_TASK_REPLY_CHARS);
  if (reply === undefined) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  return {
    ok: true,
    input: Object.freeze({ taskId, reply }),
  };
}

function parseExactObject(
  input: unknown,
  allowedKeys: Set<string>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: AiSafeError } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== allowedKeys.size) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  for (const key of keys) {
    if (!allowedKeys.has(key) || FORBIDDEN_AUTHORITY_FIELDS.has(key)) {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
  }
  return { ok: true, value: record };
}

function parseTaskId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AUTONOMOUS_TASK_ID_CHARS) {
    return undefined;
  }
  return trimmed;
}

function parseBoundedTrimmedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return undefined;
  }
  return trimmed;
}
