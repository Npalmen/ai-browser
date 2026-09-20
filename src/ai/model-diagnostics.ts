import type { ModelErrorCode } from './model-errors';
import {
  MODEL_FAILURE_CATEGORIES,
  MODEL_FAILURE_PHASES,
  type ModelFailureCategory,
  type ModelFailurePhase,
} from './model-errors';
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

const SAFE_FAILURE_CATEGORIES = new Set<string>(MODEL_FAILURE_CATEGORIES);
const SAFE_FAILURE_PHASES = new Set<string>(MODEL_FAILURE_PHASES);

export interface ModelStepFailedDiagnostics {
  readonly code: ModelErrorCode;
  readonly iteration: number;
  readonly postNavigation: boolean;
  readonly alias?: ModelAlias;
  readonly fallbackAttempts?: number;
  readonly category?: ModelFailureCategory;
  readonly failurePhase?: ModelFailurePhase;
  readonly providerStatus?: number;
}

export interface ModelRequestFailedDiagnostics {
  readonly alias: ModelAlias;
  readonly code: ModelErrorCode;
  readonly fallbackCount?: number;
  readonly category?: ModelFailureCategory;
  readonly failurePhase?: ModelFailurePhase;
  readonly providerStatus?: number;
}

function sanitizeModelErrorCode(code: ModelErrorCode): ModelErrorCode {
  return MODEL_ERROR_CODES.has(code) ? code : 'MODEL_REQUEST_FAILED';
}

function isSafeModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(value);
}

function sanitizeCategory(value: ModelFailureCategory | undefined): ModelFailureCategory {
  return value !== undefined && SAFE_FAILURE_CATEGORIES.has(value) ? value : 'unknown';
}

function sanitizePhase(value: ModelFailurePhase | undefined): ModelFailurePhase {
  return value !== undefined && SAFE_FAILURE_PHASES.has(value) ? value : 'unknown';
}

function sanitizeProviderStatus(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 100 || value > 599) {
    return undefined;
  }
  return value;
}

function appendSafeRuntimeFields(
  parts: string[],
  diagnostics: {
    category?: ModelFailureCategory;
    failurePhase?: ModelFailurePhase;
    providerStatus?: number;
  },
): void {
  parts.push(`category=${sanitizeCategory(diagnostics.category)}`);
  parts.push(`phase=${sanitizePhase(diagnostics.failurePhase)}`);
  const status = sanitizeProviderStatus(diagnostics.providerStatus);
  if (status !== undefined) {
    parts.push(`providerStatus=${status}`);
  }
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
  appendSafeRuntimeFields(parts, diagnostics);
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
  appendSafeRuntimeFields(parts, diagnostics);
  return parts.join(' ');
}

export function logAgentLoopModelStepFailed(diagnostics: ModelStepFailedDiagnostics): void {
  console.log(formatAgentLoopModelStepFailed(diagnostics));
}

export function logModelRequestFailed(diagnostics: ModelRequestFailedDiagnostics): void {
  console.log(formatModelRequestFailed(diagnostics));
}
