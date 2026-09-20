import type { ModelErrorCode } from './model-errors';
import { MODEL_ALIASES, type ModelAlias } from './model-types';

const MODEL_ERROR_CODES = new Set<ModelErrorCode>([
  'MODEL_NOT_CONFIGURED',
  'MODEL_UNAVAILABLE',
  'REQUEST_CANCELLED',
  'CONTEXT_TOO_LARGE',
  'MODEL_TIMEOUT',
  'MODEL_RATE_LIMITED',
  'MODEL_AUTH_FAILED',
  'MODEL_OUTPUT_INVALID',
  'MODEL_REQUEST_FAILED',
]);

export interface ModelStepFailedDiagnostics {
  readonly code: ModelErrorCode;
  readonly iteration: number;
  readonly postNavigation: boolean;
  readonly alias?: ModelAlias;
  readonly fallbackAttempts?: number;
}

export interface ModelRequestFailedDiagnostics {
  readonly alias: ModelAlias;
  readonly code: ModelErrorCode;
  readonly fallbackCount?: number;
}

function sanitizeModelErrorCode(code: ModelErrorCode): ModelErrorCode {
  return MODEL_ERROR_CODES.has(code) ? code : 'MODEL_REQUEST_FAILED';
}

function isSafeModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(value);
}

export function formatAgentLoopModelStepFailed(
  diagnostics: ModelStepFailedDiagnostics,
): string {
  const parts = [
    '[agent-loop] model-step-failed',
    `code=${sanitizeModelErrorCode(diagnostics.code)}`,
    `iteration=${diagnostics.iteration}`,
    `postNavigation=${diagnostics.postNavigation}`,
  ];
  if (diagnostics.alias !== undefined && isSafeModelAlias(diagnostics.alias)) {
    parts.push(`alias=${diagnostics.alias}`);
  }
  if (diagnostics.fallbackAttempts !== undefined && diagnostics.fallbackAttempts >= 0) {
    parts.push(`fallbackAttempts=${diagnostics.fallbackAttempts}`);
  }
  return parts.join(' ');
}

export function formatModelRequestFailed(diagnostics: ModelRequestFailedDiagnostics): string {
  const parts = [
    '[model] request-failed',
    `alias=${diagnostics.alias}`,
    `code=${sanitizeModelErrorCode(diagnostics.code)}`,
  ];
  if (diagnostics.fallbackCount !== undefined && diagnostics.fallbackCount >= 0) {
    parts.push(`fallbackCount=${diagnostics.fallbackCount}`);
  }
  return parts.join(' ');
}

export function logAgentLoopModelStepFailed(diagnostics: ModelStepFailedDiagnostics): void {
  console.log(formatAgentLoopModelStepFailed(diagnostics));
}

export function logModelRequestFailed(diagnostics: ModelRequestFailedDiagnostics): void {
  console.log(formatModelRequestFailed(diagnostics));
}
