import { ModelError } from '../ai/model-errors';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import type { AiNativeSafeError } from '../shared/ai-native-types';
import { ObservationError } from '../shared/observation-types';

export function toAiNativeContextError(error: unknown): AiNativeSafeError {
  if (error instanceof ModelError) {
    if (error.code === 'REQUEST_CANCELLED') {
      return aiNativeSafeError('AI_NATIVE_REQUEST_CANCELLED');
    }
    if (error.code === 'CONTEXT_TOO_LARGE') {
      return aiNativeSafeError('AI_NATIVE_CONTEXT_TOO_LARGE');
    }
    return aiNativeSafeError('AI_NATIVE_MODEL_FAILED');
  }
  if (error instanceof ObservationError) {
    return aiNativeSafeError('AI_NATIVE_CONTEXT_UNAVAILABLE');
  }
  return aiNativeSafeError('AI_NATIVE_MODEL_FAILED');
}

export function isAiNativeContextCancelled(error: unknown): boolean {
  return error instanceof ModelError && error.code === 'REQUEST_CANCELLED';
}
