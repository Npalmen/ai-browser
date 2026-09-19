export type DurableWorkflowErrorCode =
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_DISABLED'
  | 'WORKFLOW_REVIEW_REQUIRED'
  | 'WORKFLOW_RUNNING'
  | 'WORKFLOW_OCCURRENCE_NOT_FOUND'
  | 'WORKFLOW_OCCURRENCE_INVALID_STATE'
  | 'WORKFLOW_BUSY'
  | 'WORKFLOW_CONCURRENT_MODIFICATION'
  | 'WORKFLOW_INVALID_REQUEST'
  | 'WORKFLOW_NOT_INITIALIZED';

export class DurableWorkflowError extends Error {
  readonly code: DurableWorkflowErrorCode;

  constructor(code: DurableWorkflowErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'DurableWorkflowError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isDurableWorkflowError(error: unknown): error is DurableWorkflowError {
  return error instanceof DurableWorkflowError;
}
