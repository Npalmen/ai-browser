import type { ModelAlias } from './model-types';

export type ModelErrorCode =
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_UNAVAILABLE'
  | 'REQUEST_CANCELLED'
  | 'CONTEXT_TOO_LARGE'
  | 'MODEL_TIMEOUT'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_OUTPUT_INVALID'
  | 'MODEL_REQUEST_FAILED';

export const MODEL_FAILURE_CATEGORIES = [
  'timeout',
  'cancelled',
  'output-invalid',
  'auth',
  'rate-limited',
  'unavailable',
  'not-configured',
  'provider-http',
  'unknown',
] as const;
export type ModelFailureCategory = (typeof MODEL_FAILURE_CATEGORIES)[number];

export const MODEL_FAILURE_PHASES = [
  'before-stream',
  'during-partial',
  'awaiting-structured',
  'unknown',
] as const;
export type ModelFailurePhase = (typeof MODEL_FAILURE_PHASES)[number];

export interface ModelErrorDiagnostics {
  readonly alias?: ModelAlias;
  readonly fallbackAttempts?: number;
  readonly category?: ModelFailureCategory;
  readonly failurePhase?: ModelFailurePhase;
  readonly providerStatus?: number;
}

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly alias?: ModelAlias;
  readonly fallbackAttempts?: number;
  readonly category?: ModelFailureCategory;
  readonly failurePhase?: ModelFailurePhase;
  readonly providerStatus?: number;

  constructor(
    code: ModelErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      alias?: ModelAlias;
      fallbackAttempts?: number;
      category?: ModelFailureCategory;
      failurePhase?: ModelFailurePhase;
      providerStatus?: number;
    },
  ) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    if (options?.alias !== undefined) {
      this.alias = options.alias;
    }
    if (options?.fallbackAttempts !== undefined) {
      this.fallbackAttempts = options.fallbackAttempts;
    }
    if (options?.category !== undefined) {
      this.category = options.category;
    }
    if (options?.failurePhase !== undefined) {
      this.failurePhase = options.failurePhase;
    }
    if (options?.providerStatus !== undefined) {
      this.providerStatus = options.providerStatus;
    }
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function categoryForModelError(
  code: ModelErrorCode,
  providerStatus?: number,
): ModelFailureCategory {
  switch (code) {
    case 'MODEL_TIMEOUT':
      return 'timeout';
    case 'MODEL_AUTH_FAILED':
      return 'auth';
    case 'MODEL_RATE_LIMITED':
      return 'rate-limited';
    case 'MODEL_UNAVAILABLE':
      return 'unavailable';
    case 'MODEL_NOT_CONFIGURED':
      return 'not-configured';
    case 'MODEL_OUTPUT_INVALID':
    case 'CONTEXT_TOO_LARGE':
      return 'output-invalid';
    case 'REQUEST_CANCELLED':
      return 'cancelled';
    case 'MODEL_REQUEST_FAILED':
      return providerStatus !== undefined ? 'provider-http' : 'unknown';
    default:
      return 'unknown';
  }
}

export function withModelErrorDiagnostics(
  error: ModelError,
  diagnostics: ModelErrorDiagnostics,
): ModelError {
  const alias = diagnostics.alias ?? error.alias;
  const fallbackAttempts = diagnostics.fallbackAttempts ?? error.fallbackAttempts;
  const category = diagnostics.category ?? error.category;
  const failurePhase = diagnostics.failurePhase ?? error.failurePhase;
  const providerStatus = diagnostics.providerStatus ?? error.providerStatus;
  if (
    error.alias === alias &&
    error.fallbackAttempts === fallbackAttempts &&
    error.category === category &&
    error.failurePhase === failurePhase &&
    error.providerStatus === providerStatus
  ) {
    return error;
  }
  return new ModelError(error.code, error.message, {
    cause: error.cause,
    alias,
    fallbackAttempts,
    category,
    failurePhase,
    providerStatus,
  });
}

export function annotateModelFailure(
  error: ModelError,
  context: {
    failurePhase?: ModelFailurePhase;
    providerStatus?: number;
  },
): ModelError {
  const providerStatus = context.providerStatus ?? error.providerStatus;
  return withModelErrorDiagnostics(error, {
    category: error.category ?? categoryForModelError(error.code, providerStatus),
    failurePhase: context.failurePhase ?? error.failurePhase,
    providerStatus,
  });
}
