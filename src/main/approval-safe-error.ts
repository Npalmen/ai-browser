import { ApprovalError } from '../shared/approval-errors';
import type { ApprovalSafeError, ApprovalSafeErrorCode } from '../shared/approval-types';

const APPROVAL_SAFE_MESSAGES: Record<ApprovalSafeErrorCode, string> = {
  INVALID_REQUEST: 'The approval request was invalid.',
  APPROVAL_NOT_FOUND: 'This approval is no longer available.',
  APPROVAL_ALREADY_DECIDED: 'This approval has already been decided.',
  APPROVAL_EXPIRED: 'This approval has expired.',
  APPROVAL_STALE: 'The page changed and this approval is no longer valid.',
  APPROVAL_FAILED: 'The approval decision failed.',
  EXECUTION_FAILED: 'The approved action could not be performed.',
  EXECUTION_STATE_UNKNOWN:
    'The action may have been performed, but the final page state could not be confirmed. Do not retry automatically.',
};

export function approvalSafeError(code: ApprovalSafeErrorCode): ApprovalSafeError {
  return Object.freeze({
    code,
    message: APPROVAL_SAFE_MESSAGES[code],
  });
}

export function toApprovalSafeError(error: unknown): ApprovalSafeError {
  if (error instanceof ApprovalError) {
    switch (error.code) {
      case 'APPROVAL_NOT_FOUND':
        return approvalSafeError('APPROVAL_NOT_FOUND');
      case 'APPROVAL_ALREADY_DECIDED':
        return approvalSafeError('APPROVAL_ALREADY_DECIDED');
      case 'APPROVAL_EXPIRED':
        return approvalSafeError('APPROVAL_EXPIRED');
      case 'APPROVAL_STALE':
        return approvalSafeError('APPROVAL_STALE');
      default:
        return approvalSafeError('APPROVAL_FAILED');
    }
  }
  return approvalSafeError('APPROVAL_FAILED');
}
