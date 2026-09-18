import type { AiRequestMode, AiSafeError } from '../shared/ai-types';
import { aiSafeError } from './ai-safe-error';

const MAX_ASK_ID_CHARS = 128;
const ASK_CURRENT_PAGE_KEYS = new Set(['tabId', 'question', 'mode']);

export function parseTabId(value: unknown): string | AiSafeError {
  if (typeof value !== 'string' || value.length === 0) {
    return aiSafeError('INVALID_REQUEST');
  }
  return value;
}

export function parseQuestion(value: unknown): string | AiSafeError {
  if (typeof value !== 'string') {
    return aiSafeError('INVALID_REQUEST');
  }
  const question = value.trim();
  if (question.length === 0) {
    return aiSafeError('INVALID_REQUEST');
  }
  return question;
}

export function parseAskId(value: unknown): string | AiSafeError {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ASK_ID_CHARS) {
    return aiSafeError('INVALID_REQUEST');
  }
  return value;
}

export function parsePanelOpen(value: unknown): boolean | AiSafeError {
  if (typeof value !== 'boolean') {
    return aiSafeError('INVALID_REQUEST');
  }
  return value;
}

export function parseRequestMode(value: unknown): AiRequestMode | AiSafeError {
  if (value === 'read' || value === 'interact') {
    return value;
  }
  return aiSafeError('INVALID_REQUEST');
}

export function isAiSafeError(value: string | boolean | AiSafeError): value is AiSafeError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

export function parseAskCurrentPageRequest(
  input: unknown,
  browserState: { activeTabId: string | null; tabs: ReadonlyArray<{ id: string }> },
): { ok: true; tabId: string; question: string; mode: AiRequestMode } | { ok: false; error: AiSafeError } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ASK_CURRENT_PAGE_KEYS.size) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  for (const key of ASK_CURRENT_PAGE_KEYS) {
    if (!keys.includes(key)) {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
  }

  const tabId = parseTabId(record.tabId);
  if (isAiSafeError(tabId)) {
    return { ok: false, error: tabId };
  }
  const question = parseQuestion(record.question);
  if (isAiSafeError(question)) {
    return { ok: false, error: question };
  }
  const mode = parseRequestMode(record.mode);
  if (isAiSafeError(mode)) {
    return { ok: false, error: mode };
  }

  const tabExists = browserState.tabs.some((tab) => tab.id === tabId);
  if (!tabExists || browserState.activeTabId !== tabId) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }

  return { ok: true, tabId, question, mode };
}
