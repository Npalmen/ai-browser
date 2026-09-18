export type ApprovalErrorCode =
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_ALREADY_DECIDED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_STALE'
  | 'EXECUTE_GRANT_ALREADY_CLAIMED'
  | 'EXECUTION_NOT_FOUND'
  | 'INVALID_APPROVAL_TRANSITION'
  | 'AUTHORITY_ID_COLLISION'
  | 'PREPARE_ACTION_NOT_DEFERRED'
  | 'PREPARE_ACTION_UNSUPPORTED_KIND'
  | 'PREPARE_ACTION_IDENTITY_MISMATCH'
  | 'PREPARE_ACTION_TARGET_NOT_FOUND'
  | 'INVALID_EXECUTE_GRANT'
  | 'EXECUTE_IN_PROGRESS';

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
