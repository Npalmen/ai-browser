import type {
  WorkflowProductError,
  WorkflowProductErrorCode,
} from '../shared/workflow-product-types';
import { isDurableWorkflowError } from '../workflows/durable-workflow-errors';
import { isWorkflowStoreError } from '../workflows/workflow-store-errors';

const SAFE_MESSAGES: Record<WorkflowProductErrorCode, string> = {
  WORKFLOW_NOT_AVAILABLE: 'Workflows are not available.',
  WORKFLOW_INVALID_REQUEST: 'The workflow request was invalid.',
  WORKFLOW_NOT_FOUND: 'That workflow was not found.',
  WORKFLOW_DISABLED: 'This workflow is disabled.',
  WORKFLOW_REVIEW_REQUIRED: 'This workflow requires review before it can run.',
  WORKFLOW_RUNNING: 'Stop the current run before deleting this workflow.',
  WORKFLOW_BUSY: 'Another workflow is already running.',
  WORKFLOW_STORAGE_ERROR:
    'Persistent workflows are unavailable because their local data could not be loaded safely.',
  WORKFLOW_CONCURRENT_MODIFICATION: 'The workflow was changed. Try again.',
  WORKFLOW_OPERATION_FAILED: 'The workflow operation failed.',
};

export function workflowProductError(code: WorkflowProductErrorCode): WorkflowProductError {
  return { code, message: SAFE_MESSAGES[code] };
}

export function toWorkflowProductError(error: unknown): WorkflowProductError {
  if (isWorkflowStoreError(error)) {
    return workflowProductError('WORKFLOW_STORAGE_ERROR');
  }
  if (isDurableWorkflowError(error)) {
    switch (error.code) {
      case 'WORKFLOW_NOT_FOUND':
      case 'WORKFLOW_OCCURRENCE_NOT_FOUND':
        return workflowProductError('WORKFLOW_NOT_FOUND');
      case 'WORKFLOW_DISABLED':
        return workflowProductError('WORKFLOW_DISABLED');
      case 'WORKFLOW_REVIEW_REQUIRED':
        return workflowProductError('WORKFLOW_REVIEW_REQUIRED');
      case 'WORKFLOW_RUNNING':
        return workflowProductError('WORKFLOW_RUNNING');
      case 'WORKFLOW_BUSY':
        return workflowProductError('WORKFLOW_BUSY');
      case 'WORKFLOW_CONCURRENT_MODIFICATION':
        return workflowProductError('WORKFLOW_CONCURRENT_MODIFICATION');
      case 'WORKFLOW_INVALID_REQUEST':
        return workflowProductError('WORKFLOW_INVALID_REQUEST');
      case 'WORKFLOW_NOT_INITIALIZED':
        return workflowProductError('WORKFLOW_NOT_AVAILABLE');
      default:
        return workflowProductError('WORKFLOW_OPERATION_FAILED');
    }
  }
  return workflowProductError('WORKFLOW_OPERATION_FAILED');
}
