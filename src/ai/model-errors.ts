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

export class ModelError extends Error {
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
