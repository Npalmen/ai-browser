import type { ModelErrorCode } from './model-errors';
import {
  MODEL_FAILURE_CATEGORIES,
  MODEL_FAILURE_PHASES,
  type ModelFailureCategory,
  type ModelFailurePhase,
} from './model-errors';
import { MODEL_ALIASES, type ModelAlias } from './model-types';

const MODEL_ERROR_CODES = new Set<ModelErrorCode>([
  'MODEL_NOT_CONFIGURED',
  'MODEL_UNAVAILABLE',
  'REQUEST_CANCELLED',
  'CONTEXT_TOO_LARGE',
  'MODEL_TIMEOUT',
  'MODEL_RATE_LIMITED',
  'MODEL_AUTH_FAILED',
  'MODEL_OUTPUT_INVALID',
  'MODEL_REQUEST_FAILED',
]);

const SAFE_FAILURE_CATEGORIES = new Set<string>(MODEL_FAILURE_CATEGORIES);
const SAFE_FAILURE_PHASES = new Set<string>(MODEL_FAILURE_PHASES);

export interface ModelStepFailedDiagnostics {
  readonly code: ModelErrorCode;
  readonly iteration: number;
  readonly postNavigation: boolean;
  readonly alias?: ModelAlias;
  readonly fallbackAttempts?: number;
  readonly category?: ModelFailureCategory;
  readonly failurePhase?: ModelFailurePhase;
  readonly providerStatus?: number;
}

export interface ModelRequestFailedDiagnostics {
  readonly alias: ModelAlias;
  readonly code: ModelErrorCode;
  readonly fallbackCount?: number;
  readonly category?: ModelFailureCategory;
  readonly failurePhase?: ModelFailurePhase;
  readonly providerStatus?: number;
}

function sanitizeModelErrorCode(code: ModelErrorCode): ModelErrorCode {
  return MODEL_ERROR_CODES.has(code) ? code : 'MODEL_REQUEST_FAILED';
}

function isSafeModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(value);
}

function sanitizeCategory(value: ModelFailureCategory | undefined): ModelFailureCategory {
  return value !== undefined && SAFE_FAILURE_CATEGORIES.has(value) ? value : 'unknown';
}

function sanitizePhase(value: ModelFailurePhase | undefined): ModelFailurePhase {
  return value !== undefined && SAFE_FAILURE_PHASES.has(value) ? value : 'unknown';
}

function sanitizeProviderStatus(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 100 || value > 599) {
    return undefined;
  }
  return value;
}

function appendSafeRuntimeFields(
  parts: string[],
  diagnostics: {
    category?: ModelFailureCategory;
    failurePhase?: ModelFailurePhase;
    providerStatus?: number;
  },
): void {
  parts.push(`category=${sanitizeCategory(diagnostics.category)}`);
  parts.push(`phase=${sanitizePhase(diagnostics.failurePhase)}`);
  const status = sanitizeProviderStatus(diagnostics.providerStatus);
  if (status !== undefined) {
    parts.push(`providerStatus=${status}`);
  }
}

export function formatAgentLoopModelStepFailed(
  diagnostics: ModelStepFailedDiagnostics,
): string {
  const parts = [
    '[agent-loop] model-step-failed',
    `code=${sanitizeModelErrorCode(diagnostics.code)}`,
    `iteration=${diagnostics.iteration}`,
    `postNavigation=${diagnostics.postNavigation}`,
  ];
  if (diagnostics.alias !== undefined && isSafeModelAlias(diagnostics.alias)) {
    parts.push(`alias=${diagnostics.alias}`);
  }
  if (diagnostics.fallbackAttempts !== undefined && diagnostics.fallbackAttempts >= 0) {
    parts.push(`fallbackAttempts=${diagnostics.fallbackAttempts}`);
  }
  appendSafeRuntimeFields(parts, diagnostics);
  return parts.join(' ');
}

export function formatModelRequestFailed(diagnostics: ModelRequestFailedDiagnostics): string {
  const parts = [
    '[model] request-failed',
    `alias=${diagnostics.alias}`,
    `code=${sanitizeModelErrorCode(diagnostics.code)}`,
  ];
  if (diagnostics.fallbackCount !== undefined && diagnostics.fallbackCount >= 0) {
    parts.push(`fallbackCount=${diagnostics.fallbackCount}`);
  }
  appendSafeRuntimeFields(parts, diagnostics);
  return parts.join(' ');
}

export function logAgentLoopModelStepFailed(diagnostics: ModelStepFailedDiagnostics): void {
  console.log(formatAgentLoopModelStepFailed(diagnostics));
}

export function logModelRequestFailed(diagnostics: ModelRequestFailedDiagnostics): void {
  console.log(formatModelRequestFailed(diagnostics));
}

const SAFE_ACTION_KINDS = new Set(['click', 'type', 'select', 'scroll', 'execute']);
const SAFE_ANSWER_DISPOSITIONS = new Set([
  'informational',
  'cannot-complete',
  'needs-clarification',
  'task-complete',
]);
const SAFE_COMPLETION_EVIDENCE = new Set([
  'navigation',
  'page-change',
  'observable-effect',
  'approved-execution',
]);
const SAFE_DEFERRED_REASONS = new Set(['no-observable-effect']);

function sanitizeAllowlisted(value: string, allowed: Set<string>, fallback: string): string {
  return allowed.has(value) ? value : fallback;
}

export function formatAgentLoopAnswerReceived(diagnostics: {
  readonly disposition: string;
  readonly trustedActions: number;
  readonly iteration: number;
}): string {
  return [
    '[agent-loop] answer-received',
    `disposition=${sanitizeAllowlisted(diagnostics.disposition, SAFE_ANSWER_DISPOSITIONS, 'unknown')}`,
    `trustedActions=${Math.max(0, Math.floor(diagnostics.trustedActions))}`,
    `iteration=${Math.max(0, Math.floor(diagnostics.iteration))}`,
  ].join(' ');
}

export function formatAgentLoopFalseCompletionReplan(iteration: number): string {
  return `[agent-loop] false-completion-replan iteration=${Math.max(0, Math.floor(iteration))}`;
}

export function formatAgentLoopTrustedActionSuccess(diagnostics: {
  readonly kind: string;
  readonly navigated: boolean;
  readonly observableEffect: boolean;
}): string {
  return [
    '[agent-loop] trusted-action-success',
    `kind=${sanitizeAllowlisted(diagnostics.kind, SAFE_ACTION_KINDS, 'unknown')}`,
    `navigated=${diagnostics.navigated === true}`,
    `observableEffect=${diagnostics.observableEffect === true}`,
  ].join(' ');
}

export function formatAgentLoopCompleteOnSuccessHonored(diagnostics: {
  readonly kind: string;
  readonly evidence: string;
}): string {
  return [
    '[agent-loop] complete-on-success-honored',
    `kind=${sanitizeAllowlisted(diagnostics.kind, SAFE_ACTION_KINDS, 'unknown')}`,
    `evidence=${sanitizeAllowlisted(diagnostics.evidence, SAFE_COMPLETION_EVIDENCE, 'unknown')}`,
  ].join(' ');
}

export function formatAgentLoopCompleteOnSuccessDeferred(diagnostics: {
  readonly kind: string;
  readonly reason: string;
}): string {
  return [
    '[agent-loop] complete-on-success-deferred',
    `kind=${sanitizeAllowlisted(diagnostics.kind, SAFE_ACTION_KINDS, 'unknown')}`,
    `reason=${sanitizeAllowlisted(diagnostics.reason, SAFE_DEFERRED_REASONS, 'unknown')}`,
  ].join(' ');
}

export function logAgentLoopAnswerReceived(
  diagnostics: Parameters<typeof formatAgentLoopAnswerReceived>[0],
): void {
  console.log(formatAgentLoopAnswerReceived(diagnostics));
}

export function logAgentLoopFalseCompletionReplan(iteration: number): void {
  console.log(formatAgentLoopFalseCompletionReplan(iteration));
}

export function logAgentLoopTrustedActionSuccess(
  diagnostics: Parameters<typeof formatAgentLoopTrustedActionSuccess>[0],
): void {
  console.log(formatAgentLoopTrustedActionSuccess(diagnostics));
}

export function logAgentLoopCompleteOnSuccessHonored(
  diagnostics: Parameters<typeof formatAgentLoopCompleteOnSuccessHonored>[0],
): void {
  console.log(formatAgentLoopCompleteOnSuccessHonored(diagnostics));
}

export function logAgentLoopCompleteOnSuccessDeferred(
  diagnostics: Parameters<typeof formatAgentLoopCompleteOnSuccessDeferred>[0],
): void {
  console.log(formatAgentLoopCompleteOnSuccessDeferred(diagnostics));
}
