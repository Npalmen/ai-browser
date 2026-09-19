import type { AiNativeSafeError, AiNativeSafeErrorCode } from './ai-native-types';

const SAFE_MESSAGES: Record<AiNativeSafeErrorCode, string> = {
  AI_NATIVE_INVALID_REQUEST: 'The browser command was invalid.',
  AI_NATIVE_EMPTY_INPUT: 'Enter a URL, search, or command.',
  AI_NATIVE_TAB_UNAVAILABLE: 'The selected tab is no longer available.',
  AI_NATIVE_CONTEXT_INVALID: 'The selected browser context is invalid.',
  AI_NATIVE_SEARCH_INVALID: 'The search query is invalid.',
  AI_NATIVE_NOT_AVAILABLE: 'This browser command is not available.',
};

export function aiNativeSafeError(code: AiNativeSafeErrorCode): AiNativeSafeError {
  return {
    code,
    message: SAFE_MESSAGES[code],
  };
}
