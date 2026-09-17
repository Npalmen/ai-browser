import { ModelError } from '../ai/model-errors';
import type { AiSafeError, AiSafeErrorCode } from '../shared/ai-types';
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
  INVALID_REQUEST: 'The AI request was invalid.',
  AI_REQUEST_FAILED: 'The AI request failed.',
};

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
  return aiSafeError('AI_REQUEST_FAILED');
}

export function isRequestCancelled(error: unknown): boolean {
  return error instanceof ModelError && error.code === 'REQUEST_CANCELLED';
}
