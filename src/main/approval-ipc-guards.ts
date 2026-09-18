import {
  MAX_APPROVAL_ID_CHARS,
  type ApprovalDecideInput,
  type ApprovalDecideResult,
  type ApprovalSafeError,
} from '../shared/approval-types';
import { approvalSafeError } from './approval-safe-error';

const APPROVAL_DECIDE_KEYS = new Set(['approvalId', 'decision']);

export function parseApprovalDecideRequest(
  input: unknown,
): { ok: true; input: ApprovalDecideInput } | { ok: false; error: ApprovalSafeError } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: approvalSafeError('INVALID_REQUEST') };
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== APPROVAL_DECIDE_KEYS.size) {
    return { ok: false, error: approvalSafeError('INVALID_REQUEST') };
  }
  for (const key of APPROVAL_DECIDE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return { ok: false, error: approvalSafeError('INVALID_REQUEST') };
    }
  }

  const approvalId = parseApprovalId(record.approvalId);
  if (approvalId === undefined) {
    return { ok: false, error: approvalSafeError('INVALID_REQUEST') };
  }
  const decision = parseApprovalDecision(record.decision);
  if (decision === undefined) {
    return { ok: false, error: approvalSafeError('INVALID_REQUEST') };
  }

  return {
    ok: true,
    input: Object.freeze({
      approvalId,
      decision,
    }),
  };
}

export function invalidApprovalDecideResult(): ApprovalDecideResult {
  return Object.freeze({
    ok: false,
    error: approvalSafeError('INVALID_REQUEST'),
  });
}

function parseApprovalId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length === 0 || value.length > MAX_APPROVAL_ID_CHARS || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function parseApprovalDecision(value: unknown): ApprovalDecideInput['decision'] | undefined {
  if (value === 'approve' || value === 'reject') {
    return value;
  }
  return undefined;
}
