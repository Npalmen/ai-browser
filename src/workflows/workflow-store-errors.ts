export type WorkflowStoreErrorCode =
  | 'WORKFLOW_STORE_REVISION_CONFLICT'
  | 'WORKFLOW_STORE_CORRUPT'
  | 'WORKFLOW_STORE_SCHEMA_UNSUPPORTED'
  | 'WORKFLOW_STORE_TOO_LARGE'
  | 'WORKFLOW_STORE_IO_FAILED'
  | 'WORKFLOW_STORE_MUTATION_INVALID';

export class WorkflowStoreError extends Error {
  readonly code: WorkflowStoreErrorCode;

  constructor(code: WorkflowStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'WorkflowStoreError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isWorkflowStoreError(error: unknown): error is WorkflowStoreError {
  return error instanceof WorkflowStoreError;
}
