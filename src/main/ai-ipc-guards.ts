import type { AiSafeError } from '../shared/ai-types';
import { aiSafeError } from './ai-safe-error';

const MAX_ASK_ID_CHARS = 128;

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

export function isAiSafeError(value: string | boolean | AiSafeError): value is AiSafeError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

export function parseAskCurrentPageRequest(
  input: unknown,
  browserState: { activeTabId: string | null; tabs: ReadonlyArray<{ id: string }> },
): { ok: true; tabId: string; question: string } | { ok: false; error: AiSafeError } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }
  const record = input as Record<string, unknown>;
  const tabId = parseTabId(record.tabId);
  if (isAiSafeError(tabId)) {
    return { ok: false, error: tabId };
  }
  const question = parseQuestion(record.question);
  if (isAiSafeError(question)) {
    return { ok: false, error: question };
  }

  const tabExists = browserState.tabs.some((tab) => tab.id === tabId);
  if (!tabExists || browserState.activeTabId !== tabId) {
    return { ok: false, error: aiSafeError('INVALID_REQUEST') };
  }

  return { ok: true, tabId, question };
}
