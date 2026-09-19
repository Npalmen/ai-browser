import type {
  BrowserContextScope,
  BrowserIntentCapability,
  BrowserIntentRouteInput,
} from '../shared/ai-native-types';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import type { AiNativeSafeError } from '../shared/ai-native-types';

const ROUTE_INTENT_KEYS = new Set(['text', 'capability', 'context']);
const CURRENT_TAB_KEYS = new Set(['kind', 'tabId']);
const SELECTED_TABS_KEYS = new Set(['kind', 'tabIds']);

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

  let context: BrowserContextScope | undefined;
  if ('context' in record) {
    const parsedContext = parseContext(record.context);
    if (isAiNativeSafeError(parsedContext)) {
      return { ok: false, error: parsedContext };
    }
    context = parsedContext;
  }

  const routeInput: BrowserIntentRouteInput = context
    ? { text: record.text, capability, context }
    : { text: record.text, capability };

  return { ok: true, input: routeInput };
}
