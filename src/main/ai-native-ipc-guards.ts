import { MODEL_CONTEXT_BUDGETS } from '../ai/context-builder';
import type {
  AiNativeContextAskInput,
  AiNativeWorkflowDraftInput,
  BrowserContextScope,
  BrowserIntentCapability,
  BrowserIntentRouteInput,
} from '../shared/ai-native-types';
import { MAX_CONTEXT_TABS } from '../shared/ai-native-types';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import type { AiNativeSafeError } from '../shared/ai-native-types';

const ROUTE_INTENT_KEYS = new Set(['text', 'capability', 'context']);
const CURRENT_TAB_KEYS = new Set(['kind', 'tabId']);
const SELECTED_TABS_KEYS = new Set(['kind', 'tabIds']);
const ASK_CONTEXT_KEYS = new Set(['question', 'context']);
const CANCEL_CONTEXT_ASK_KEYS = new Set(['askId']);
const GENERATE_WORKFLOW_DRAFT_KEYS = new Set(['instruction', 'context']);

const FORBIDDEN_CONTEXT_ASK_FIELDS = new Set([
  'targetId',
  'observationId',
  'documentRevision',
  'approvalId',
  'taskId',
  'workflowId',
  'triggerKey',
  'model',
  'needsVision',
  'contextId',
  'capability',
  'route',
  'grant',
  'runId',
  'preparedActionId',
  'executionId',
  'enabled',
  'runNow',
  'occurrenceId',
  'timeZone',
  'now',
]);

const FORBIDDEN_ROUTE_INTENT_FIELDS = new Set([
  'targetId',
  'observationId',
  'approvalId',
  'taskId',
  'workflowId',
  'triggerKey',
  'executionId',
  'grant',
  'runId',
  'preparedActionId',
  'url',
  'urls',
  'title',
  'titles',
  'PageObservation',
]);

const CAPABILITIES = new Set<BrowserIntentCapability>([
  'default',
  'search',
  'ask',
  'act',
  'delegate',
  'automate',
]);

const CONTEXT_REQUIRED_CAPABILITIES = new Set<BrowserIntentCapability>(['ask', 'automate']);

export function isAiNativeSafeError(value: unknown): value is AiNativeSafeError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

function invalidRequest(): { ok: false; error: AiNativeSafeError } {
  return { ok: false, error: aiNativeSafeError('AI_NATIVE_INVALID_REQUEST') };
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(record);
  if (keys.length !== allowed.size) {
    return false;
  }
  for (const key of allowed) {
    if (!keys.includes(key)) {
      return false;
    }
  }
  return true;
}

function rejectForbiddenRouteIntentKeys(record: Record<string, unknown>): boolean {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_ROUTE_INTENT_FIELDS.has(key)) {
      return true;
    }
  }
  return false;
}

function parseCapability(value: unknown): BrowserIntentCapability | AiNativeSafeError {
  if (typeof value !== 'string' || !CAPABILITIES.has(value as BrowserIntentCapability)) {
    return aiNativeSafeError('AI_NATIVE_INVALID_REQUEST');
  }
  return value as BrowserIntentCapability;
}

function parseTabId(value: unknown): string | AiNativeSafeError {
  if (typeof value !== 'string' || value.length === 0) {
    return aiNativeSafeError('AI_NATIVE_INVALID_REQUEST');
  }
  return value;
}

function parseContext(value: unknown): BrowserContextScope | AiNativeSafeError {
  if (typeof value !== 'object' || value === null) {
    return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
  }

  const record = value as Record<string, unknown>;

  if (record.kind === 'current-tab') {
    if (!hasOnlyKeys(record, CURRENT_TAB_KEYS)) {
      return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
    }
    const tabId = parseTabId(record.tabId);
    if (isAiNativeSafeError(tabId)) {
      return tabId;
    }
    return { kind: 'current-tab', tabId };
  }

  if (record.kind === 'selected-tabs') {
    if (!hasOnlyKeys(record, SELECTED_TABS_KEYS)) {
      return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
    }
    if (!Array.isArray(record.tabIds)) {
      return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
    }
    const tabIds: string[] = [];
    for (const tabId of record.tabIds) {
      const parsed = parseTabId(tabId);
      if (isAiNativeSafeError(parsed)) {
        return parsed;
      }
      tabIds.push(parsed);
    }
    return { kind: 'selected-tabs', tabIds };
  }

  return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
}

function parseSelectedTabsContext(
  value: unknown,
): { kind: 'selected-tabs'; tabIds: string[] } | AiNativeSafeError {
  if (typeof value !== 'object' || value === null) {
    return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
  }
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, SELECTED_TABS_KEYS) || record.kind !== 'selected-tabs') {
    return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
  }
  if (!Array.isArray(record.tabIds)) {
    return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
  }
  if (record.tabIds.length === 0 || record.tabIds.length > MAX_CONTEXT_TABS) {
    return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
  }
  const tabIds: string[] = [];
  const seen = new Set<string>();
  for (const tabId of record.tabIds) {
    const parsed = parseTabId(tabId);
    if (isAiNativeSafeError(parsed)) {
      return parsed;
    }
    if (seen.has(parsed)) {
      return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
    }
    seen.add(parsed);
    tabIds.push(parsed);
  }
  return { kind: 'selected-tabs', tabIds };
}

function rejectForbiddenContextAskKeys(record: Record<string, unknown>): boolean {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_CONTEXT_ASK_FIELDS.has(key)) {
      return true;
    }
  }
  return false;
}

export function parseContextAskRequest(
  input: unknown,
): { ok: true; input: AiNativeContextAskInput } | { ok: false; error: AiNativeSafeError } {
  if (typeof input !== 'object' || input === null) {
    return invalidRequest();
  }

  const record = input as Record<string, unknown>;
  if (rejectForbiddenContextAskKeys(record)) {
    return invalidRequest();
  }

  const keys = Object.keys(record);
  if (!keys.every((key) => ASK_CONTEXT_KEYS.has(key)) || !hasOnlyKeys(record, ASK_CONTEXT_KEYS)) {
    return invalidRequest();
  }

  if (typeof record.question !== 'string') {
    return invalidRequest();
  }
  const question = record.question.trim();
  if (question.length === 0) {
    return { ok: false, error: aiNativeSafeError('AI_NATIVE_EMPTY_INPUT') };
  }
  if (question.length > MODEL_CONTEXT_BUDGETS.maxUserQuestionChars) {
    return invalidRequest();
  }

  const parsedContext = parseSelectedTabsContext(record.context);
  if (isAiNativeSafeError(parsedContext)) {
    return { ok: false, error: parsedContext };
  }

  return {
    ok: true,
    input: {
      question: record.question,
      context: parsedContext,
    },
  };
}

export function parseCancelContextAskRequest(
  input: unknown,
): { ok: true; askId: string } | { ok: false; error: AiNativeSafeError } {
  if (typeof input !== 'object' || input === null) {
    return invalidRequest();
  }
  const record = input as Record<string, unknown>;
  if (!hasOnlyKeys(record, CANCEL_CONTEXT_ASK_KEYS)) {
    return invalidRequest();
  }
  if (typeof record.askId !== 'string' || record.askId.length === 0) {
    return invalidRequest();
  }
  return { ok: true, askId: record.askId };
}

export function parseGenerateWorkflowDraftRequest(
  input: unknown,
): { ok: true; input: AiNativeWorkflowDraftInput } | { ok: false; error: AiNativeSafeError } {
  if (typeof input !== 'object' || input === null) {
    return invalidRequest();
  }

  const record = input as Record<string, unknown>;
  if (rejectForbiddenContextAskKeys(record)) {
    return invalidRequest();
  }
  if (!hasOnlyKeys(record, GENERATE_WORKFLOW_DRAFT_KEYS)) {
    return invalidRequest();
  }
  if (typeof record.instruction !== 'string') {
    return invalidRequest();
  }
  const instruction = record.instruction.trim();
  if (instruction.length === 0) {
    return { ok: false, error: aiNativeSafeError('AI_NATIVE_EMPTY_INPUT') };
  }
  if (instruction.length > MODEL_CONTEXT_BUDGETS.maxUserQuestionChars) {
    return invalidRequest();
  }

  const parsedContext = parseWorkflowDraftContext(record.context);
  if (isAiNativeSafeError(parsedContext)) {
    return { ok: false, error: parsedContext };
  }

  return {
    ok: true,
    input: {
      instruction,
      context: parsedContext,
    },
  };
}

function parseWorkflowDraftContext(value: unknown): BrowserContextScope | AiNativeSafeError {
  if (typeof value !== 'object' || value === null) {
    return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'current-tab') {
    return parseContext(value);
  }
  if (record.kind === 'selected-tabs') {
    return parseSelectedTabsContext(value);
  }
  return aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID');
}

export function parseRouteIntentRequest(
  input: unknown,
): { ok: true; input: BrowserIntentRouteInput } | { ok: false; error: AiNativeSafeError } {
  if (typeof input !== 'object' || input === null) {
    return invalidRequest();
  }

  const record = input as Record<string, unknown>;
  if (rejectForbiddenRouteIntentKeys(record)) {
    return invalidRequest();
  }

  const keys = Object.keys(record);
  if (!keys.every((key) => ROUTE_INTENT_KEYS.has(key))) {
    return invalidRequest();
  }
  if (!keys.includes('text') || !keys.includes('capability')) {
    return invalidRequest();
  }

  if (typeof record.text !== 'string') {
    return invalidRequest();
  }

  const capability = parseCapability(record.capability);
  if (isAiNativeSafeError(capability)) {
    return { ok: false, error: capability };
  }

  const hasContext = 'context' in record;

  if (CONTEXT_REQUIRED_CAPABILITIES.has(capability)) {
    if (!hasContext) {
      return { ok: false, error: aiNativeSafeError('AI_NATIVE_CONTEXT_INVALID') };
    }
    const parsedContext = parseContext(record.context);
    if (isAiNativeSafeError(parsedContext)) {
      return { ok: false, error: parsedContext };
    }
    if (capability === 'ask') {
      return {
        ok: true,
        input: { text: record.text, capability: 'ask', context: parsedContext },
      };
    }
    return {
      ok: true,
      input: { text: record.text, capability: 'automate', context: parsedContext },
    };
  }

  if (hasContext) {
    return invalidRequest();
  }

  switch (capability) {
    case 'default':
      return { ok: true, input: { text: record.text, capability: 'default' } };
    case 'search':
      return { ok: true, input: { text: record.text, capability: 'search' } };
    case 'act':
      return { ok: true, input: { text: record.text, capability: 'act' } };
    case 'delegate':
      return { ok: true, input: { text: record.text, capability: 'delegate' } };
    default:
      return invalidRequest();
  }
}
