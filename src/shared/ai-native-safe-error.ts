import type { AiNativeSafeError, AiNativeSafeErrorCode } from './ai-native-types';

const SAFE_MESSAGES: Record<AiNativeSafeErrorCode, string> = {
  AI_NATIVE_INVALID_REQUEST: 'The browser command was invalid.',
  AI_NATIVE_EMPTY_INPUT: 'Enter a URL, search, or command.',
  AI_NATIVE_TAB_UNAVAILABLE: 'The selected tab is no longer available.',
  AI_NATIVE_CONTEXT_INVALID: 'The selected browser context is invalid.',
  AI_NATIVE_SEARCH_INVALID: 'The search query is invalid.',
  AI_NATIVE_NOT_AVAILABLE: 'This browser command is not available.',
  AI_NATIVE_CONTEXT_TOO_LARGE: 'The selected browser context is too large.',
  AI_NATIVE_CONTEXT_UNAVAILABLE: 'The selected browser context is unavailable.',
  AI_NATIVE_REQUEST_CANCELLED: 'The browser context request was cancelled.',
  AI_NATIVE_MODEL_FAILED: 'The browser context request failed.',
  AI_NATIVE_DRAFT_INVALID: 'The generated workflow draft was invalid.',
  AI_NATIVE_DRAFT_FAILED: 'Unable to generate workflow draft.',
};

export function aiNativeSafeError(code: AiNativeSafeErrorCode): AiNativeSafeError {
  return {
    code,
    message: SAFE_MESSAGES[code],
  };
}
