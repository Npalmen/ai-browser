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

export interface ModelErrorDiagnostics {
  readonly alias?: ModelAlias;
  readonly fallbackAttempts?: number;
}

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly alias?: ModelAlias;
  readonly fallbackAttempts?: number;

  constructor(
    code: ModelErrorCode,
    message: string,
    options?: { cause?: unknown; alias?: ModelAlias; fallbackAttempts?: number },
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
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function withModelErrorDiagnostics(
  error: ModelError,
  diagnostics: ModelErrorDiagnostics,
): ModelError {
  if (
    error.alias === diagnostics.alias &&
    error.fallbackAttempts === diagnostics.fallbackAttempts
  ) {
    return error;
  }
  return new ModelError(error.code, error.message, {
    cause: error.cause,
    alias: diagnostics.alias ?? error.alias,
    fallbackAttempts: diagnostics.fallbackAttempts ?? error.fallbackAttempts,
  });
}
