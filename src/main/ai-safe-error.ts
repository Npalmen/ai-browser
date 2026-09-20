import { ModelError } from '../ai/model-errors';
import type { AiSafeError, AiSafeErrorCode } from '../shared/ai-types';
import { InteractionError, type InteractionErrorCode } from '../shared/interaction-errors';
import { ObservationError } from '../shared/observation-types';

const SAFE_MESSAGES: Record<AiSafeErrorCode, string> = {
  MODEL_NOT_CONFIGURED: 'AI is not configured.',
  MODEL_UNAVAILABLE: 'The AI service is currently unavailable.',
  REQUEST_CANCELLED: 'The AI request was cancelled.',
  CONTEXT_TOO_LARGE: 'The page is too large for the AI context.',
  MODEL_TIMEOUT: 'The AI request timed out.',
  MODEL_RATE_LIMITED: 'The AI service is temporarily rate limited.',
  MODEL_AUTH_FAILED: 'AI authentication failed.',
  MODEL_OUTPUT_INVALID: 'The AI response was invalid.',
  MODEL_REQUEST_FAILED: 'The AI request failed.',
  TAB_NOT_FOUND: 'The tab is no longer available.',
  PAGE_NOT_READY: 'The page is not ready yet.',
  CDP_UNAVAILABLE: 'Page observation is temporarily unavailable.',
  PAGE_CHANGED_DURING_OBSERVATION: 'The page changed while it was being read.',
  OBSERVATION_IN_PROGRESS: 'Page observation is already in progress.',
  OBSERVATION_FAILED: 'Page observation failed.',
  INTERACTION_DENIED: 'The AI cannot perform that action on this page.',
  DEFERRED_TO_EXECUTE:
    'This action is not available without additional approval.',
  TARGET_NOT_FOUND: 'The requested page element is no longer available.',
  TARGET_NOT_EXPORTED: 'The AI cannot reference that page element.',
  TARGET_STALE: 'The page changed before the action could be completed.',
  TARGET_NOT_INTERACTIVE: 'The AI cannot interact with that element.',
  TARGET_DISABLED: 'The AI cannot interact with a disabled element.',
  TARGET_SENSITIVE: 'The AI cannot interact with this sensitive field.',
  UNSUPPORTED_TARGET: 'The AI cannot interact with that element.',
  UNSUPPORTED_FRAME: 'The AI cannot interact with content in that frame.',
  PAGE_CHANGED: 'The page changed before the action could be completed.',
  INTERACTION_IN_PROGRESS: 'Another AI interaction is already in progress.',
  INTERACTION_TIMEOUT: 'The browser interaction timed out.',
  INTERACTION_FAILED: 'The browser interaction failed.',
  INVALID_REQUEST: 'The AI request was invalid.',
  AI_REQUEST_FAILED: 'The AI request failed.',
};

const INTERACTION_SAFE_CODES = new Set<AiSafeErrorCode>([
  'INTERACTION_DENIED',
  'DEFERRED_TO_EXECUTE',
  'TARGET_NOT_FOUND',
  'TARGET_NOT_EXPORTED',
  'TARGET_STALE',
  'TARGET_NOT_INTERACTIVE',
  'TARGET_DISABLED',
  'TARGET_SENSITIVE',
  'UNSUPPORTED_TARGET',
  'UNSUPPORTED_FRAME',
  'PAGE_CHANGED',
  'INTERACTION_IN_PROGRESS',
  'INTERACTION_TIMEOUT',
  'INTERACTION_FAILED',
  'REQUEST_CANCELLED',
  'TAB_NOT_FOUND',
  'PAGE_NOT_READY',
  'PAGE_CHANGED_DURING_OBSERVATION',
  'OBSERVATION_IN_PROGRESS',
  'OBSERVATION_FAILED',
]);

export function aiSafeError(code: AiSafeErrorCode): AiSafeError {
  return {
    code,
    message: SAFE_MESSAGES[code],
  };
}

export function toAiSafeError(error: unknown): AiSafeError {
  if (error instanceof ModelError) {
    return aiSafeError(error.code);
  }
  if (error instanceof ObservationError) {
    return aiSafeError(error.code);
  }
  if (error instanceof InteractionError) {
    return toAiSafeErrorFromInteractionCode(error.code);
  }
  return aiSafeError('AI_REQUEST_FAILED');
}

export function toAiSafeErrorFromInteractionCode(
  code?: InteractionErrorCode,
): AiSafeError {
  if (code === undefined) {
    return aiSafeError('INTERACTION_FAILED');
  }
  if (INTERACTION_SAFE_CODES.has(code as AiSafeErrorCode)) {
    return aiSafeError(code as AiSafeErrorCode);
  }
  if (code === 'INVALID_INTERACTION_PROPOSAL') {
    return aiSafeError('MODEL_OUTPUT_INVALID');
  }
  return aiSafeError('INTERACTION_FAILED');
}

export function isRequestCancelled(error: unknown): boolean {
  if (error instanceof ModelError && error.code === 'REQUEST_CANCELLED') {
    return true;
  }
  return error instanceof InteractionError && error.code === 'REQUEST_CANCELLED';
}
