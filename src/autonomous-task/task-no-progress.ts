import { createHash } from 'node:crypto';

import { AutonomousTaskError } from './autonomous-task-errors';

export interface SubgoalFingerprintInput {
  readonly taskTabAlias: string;
  readonly delegatedInstruction: string;
  readonly trustedTabStateToken: string;
}

export function normalizeDelegatedInstruction(instruction: string): string {
  if (typeof instruction !== 'string') {
    throw new AutonomousTaskError(
      'INVALID_SUBGOAL_FINGERPRINT',
      'Delegated instruction must be a string.',
    );
  }
  return instruction.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function fingerprintSubgoal(input: SubgoalFingerprintInput): string {
  const alias = requireNonEmpty(input.taskTabAlias, 'INVALID_TASK_TAB_ALIAS', 'taskTabAlias');
  const normalized = normalizeDelegatedInstruction(input.delegatedInstruction);
  if (normalized.length === 0) {
    throw new AutonomousTaskError(
      'INVALID_SUBGOAL_FINGERPRINT',
      'Delegated instruction must be non-empty after normalization.',
    );
  }
  const token = requireNonEmpty(
    input.trustedTabStateToken,
    'INVALID_TRUSTED_TAB_STATE_TOKEN',
    'trustedTabStateToken',
  );
  const hash = createHash('sha256');
  hash.update(canonicalFingerprintSource(alias, normalized, token), 'utf8');
  return hash.digest('hex');
}

function canonicalFingerprintSource(alias: string, instruction: string, token: string): string {
  return `${encodeField(alias)}\n${encodeField(instruction)}\n${encodeField(token)}`;
}

function encodeField(value: string): string {
  return `${value.length}:${value}`;
}

function requireNonEmpty(
  value: string,
  code: 'INVALID_TASK_TAB_ALIAS' | 'INVALID_TRUSTED_TAB_STATE_TOKEN',
  label: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AutonomousTaskError(code, `${label} must be a non-empty string.`);
  }
  return value;
}
