export type InteractionErrorCode =
  | 'INVALID_INTERACTION_PROPOSAL'
  | 'INTERACTION_DENIED'
  | 'DEFERRED_TO_EXECUTE'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_NOT_EXPORTED'
  | 'TARGET_STALE'
  | 'TARGET_NOT_INTERACTIVE'
  | 'TARGET_DISABLED'
  | 'TARGET_SENSITIVE'
  | 'UNSUPPORTED_TARGET'
  | 'UNSUPPORTED_FRAME'
  | 'PAGE_CHANGED'
  | 'PAGE_NOT_READY'
  | 'TAB_NOT_FOUND'
  | 'INTERACTION_IN_PROGRESS'
  | 'INTERACTION_TIMEOUT'
  | 'INTERACTION_FAILED'
  | 'REQUEST_CANCELLED';

export class InteractionError extends Error {
  readonly code: InteractionErrorCode;

  constructor(code: InteractionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'InteractionError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
