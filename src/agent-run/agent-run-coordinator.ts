import { randomUUID } from 'node:crypto';

import type { TabId } from '../shared/browser-types';
import {
  buildAgentRunAuditEvent,
  type AgentRunAuditEventType,
  type AgentRunAuditSink,
} from './agent-run-audit';
import { AgentRunError } from './agent-run-errors';
import {
  isTerminalAgentRunState,
  MAX_AGENT_LOOP_ACTION_ATTEMPTS,
  MAX_AGENT_LOOP_APPROVALS,
  MAX_AGENT_LOOP_MODEL_STEPS,
  toAgentRunRef,
  type AgentRunBlockedReason,
  type AgentRunCancelledReason,
  type AgentRunFailedReason,
  type AgentRunId,
  type AgentRunMutationResult,
  type AgentRunRef,
  type AgentRunRefStatus,
  type AgentRunSnapshot,
  type AgentRunState,
  type AgentRunTerminalReason,
} from './agent-run-types';

export interface AgentRunCoordinatorDependencies {
  now?: () => number;
  generateRunId?: () => string;
  auditSink?: AgentRunAuditSink;
}

interface InternalAgentRun {
  runId: AgentRunId;
  tabId: TabId;
  generation: number;
  instruction: string;
  startedAt: number;
  state: AgentRunState;
  modelStepCount: number;
  actionAttemptCount: number;
  approvalCount: number;
  terminalReason?: AgentRunTerminalReason;
  lastSuccessfulActionFingerprint?: string;
  pendingApprovalId?: string;
}

export class AgentRunCoordinator {
  private readonly now: () => number;
  private readonly generateRunId: () => string;
  private readonly auditSink: AgentRunAuditSink | undefined;

  private readonly byRunId = new Map<AgentRunId, InternalAgentRun>();
  private readonly activeByTab = new Map<TabId, AgentRunId>();
  private readonly tabGenerations = new Map<TabId, number>();
  private readonly approvalBindings = new Map<string, AgentRunRef>();

  constructor(deps: AgentRunCoordinatorDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.generateRunId = deps.generateRunId ?? randomUUID;
    this.auditSink = deps.auditSink;
  }

  startRun(tabId: TabId, instruction: string): AgentRunSnapshot {
    requireTabId(tabId);
    const startedAt = this.now();
    const runId = requireGeneratedRunId(this.generateRunId());
    this.assertRunIdAvailable(runId);

    const generation = (this.tabGenerations.get(tabId) ?? 0) + 1;
    const record: InternalAgentRun = {
      runId,
      tabId,
      generation,
      instruction,
      startedAt,
      state: 'running',
      modelStepCount: 0,
      actionAttemptCount: 0,
      approvalCount: 0,
    };

    this.supersedeActiveRun(tabId);
    this.byRunId.set(runId, record);
    this.activeByTab.set(tabId, runId);
    this.tabGenerations.set(tabId, generation);
    this.audit('run-started', record);
    return toSnapshot(record);
  }

  getRun(runId: AgentRunId): AgentRunSnapshot | undefined {
    const record = this.byRunId.get(runId);
    return record ? toSnapshot(record) : undefined;
  }

  getActiveRunForTab(tabId: TabId): AgentRunSnapshot | undefined {
    const runId = this.activeByTab.get(tabId);
    if (runId === undefined) {
      return undefined;
    }
    const record = this.byRunId.get(runId);
    return record ? toSnapshot(record) : undefined;
  }

  isCurrentRun(ref: AgentRunRef): boolean {
    return this.inspectRun(ref).status === 'current';
  }

  inspectRun(ref: AgentRunRef): AgentRunRefStatus {
    const record = this.byRunId.get(ref.runId);
    if (record === undefined) {
      return { status: 'missing' };
    }
    const snapshot = toSnapshot(record);
    if (record.tabId !== ref.tabId || record.generation !== ref.generation) {
      return { status: 'superseded', snapshot };
    }
    const latestGeneration = this.tabGenerations.get(record.tabId);
    if (latestGeneration !== record.generation) {
      return { status: 'superseded', snapshot };
    }
    if (isTerminalAgentRunState(record.state) || this.activeByTab.get(record.tabId) !== record.runId) {
      return { status: 'terminal', snapshot };
    }
    return { status: 'current', snapshot };
  }

  getRunRefForApproval(approvalId: string): AgentRunRef | undefined {
    const binding = this.approvalBindings.get(approvalId);
    return binding ? Object.freeze({ ...binding }) : undefined;
  }

  markCompleted(ref: AgentRunRef): AgentRunMutationResult {
    return this.transitionCurrent(ref, 'completed', 'COMPLETED');
  }

  markBlocked(ref: AgentRunRef, reason: AgentRunBlockedReason): AgentRunMutationResult {
    return this.transitionCurrent(ref, 'blocked', reason);
  }

  markFailed(ref: AgentRunRef, reason: AgentRunFailedReason): AgentRunMutationResult {
    return this.transitionCurrent(ref, 'failed', reason);
  }

  markExecutionStateUnknown(ref: AgentRunRef): AgentRunMutationResult {
    return this.transitionCurrent(ref, 'execution-state-unknown', 'EXECUTION_STATE_UNKNOWN');
  }

  cancelRun(ref: AgentRunRef, reason: AgentRunCancelledReason): AgentRunMutationResult {
    return this.transitionCurrent(ref, 'cancelled', reason);
  }

  assertCanStartModelStep(ref: AgentRunRef): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertState(record, 'running');
    if (record.modelStepCount >= MAX_AGENT_LOOP_MODEL_STEPS) {
      return this.blockForBudget(record);
    }
    return applied(record);
  }

  recordModelStepCompleted(ref: AgentRunRef): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertState(record, 'running');
    if (record.modelStepCount >= MAX_AGENT_LOOP_MODEL_STEPS) {
      throw new AgentRunError(
        'AGENT_RUN_INVALID_TRANSITION',
        'Model-step budget is already exhausted.',
      );
    }
    record.modelStepCount += 1;
    this.audit('model-step-completed', record);
    return applied(record);
  }

  beginActionAttempt(ref: AgentRunRef): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertActionAttemptState(record);
    if (record.actionAttemptCount >= MAX_AGENT_LOOP_ACTION_ATTEMPTS) {
      return this.blockForBudget(record);
    }
    record.actionAttemptCount += 1;
    this.audit('action-attempt-started', record);
    return applied(record);
  }

  canPrepareAnotherAction(ref: AgentRunRef): boolean {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined || isTerminalAgentRunState(record.state)) {
      return false;
    }
    if (this.activeByTab.get(record.tabId) !== record.runId) {
      return false;
    }
    if (record.state !== 'running') {
      return false;
    }
    return hasPrepareBudget(record);
  }

  assertActionBudgetAvailable(ref: AgentRunRef): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertActionAttemptState(record);
    if (record.actionAttemptCount >= MAX_AGENT_LOOP_ACTION_ATTEMPTS) {
      return this.blockForBudget(record);
    }
    return applied(record);
  }

  presentApproval(ref: AgentRunRef, approvalId: string): AgentRunMutationResult {
    const validatedApprovalId = requireApprovalId(approvalId);
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertState(record, 'running');
    this.assertApprovalIdAvailable(validatedApprovalId);
    if (!hasPrepareBudget(record)) {
      return this.blockForBudget(record);
    }

    record.approvalCount += 1;
    record.state = 'awaiting-approval';
    record.pendingApprovalId = validatedApprovalId;
    this.approvalBindings.set(validatedApprovalId, toAgentRunRef(toSnapshot(record)));
    this.audit('state-transition', record);
    this.audit('approval-presented', record);
    return applied(record);
  }

  resumeAfterApprovedExecution(
    approvalId: string,
    expectedGeneration: number,
  ): AgentRunMutationResult {
    const binding = this.approvalBindings.get(approvalId);
    if (binding === undefined || binding.generation !== expectedGeneration) {
      return ignored();
    }
    const record = this.resolveLatestMatchingRun(binding);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertState(record, 'awaiting-approval');
    if (record.pendingApprovalId !== approvalId) {
      throw new AgentRunError(
        'AGENT_RUN_INVALID_TRANSITION',
        'Approval correlation does not match the current run.',
      );
    }
    this.clearApprovalCorrelation(record);
    record.state = 'running';
    this.audit('state-transition', record);
    return applied(record);
  }

  recordSuccessfulActionFingerprint(
    ref: AgentRunRef,
    fingerprint: string,
  ): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertState(record, 'running');
    requireFingerprint(fingerprint);
    record.lastSuccessfulActionFingerprint = fingerprint;
    return applied(record);
  }

  assertNoImmediateRepeat(ref: AgentRunRef, fingerprint: string): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertState(record, 'running');
    requireFingerprint(fingerprint);
    if (record.lastSuccessfulActionFingerprint === fingerprint) {
      return this.transitionRecord(record, 'blocked', 'AGENT_LOOP_NO_PROGRESS');
    }
    return applied(record);
  }

  clearTab(tabId: TabId): void {
    const activeId = this.activeByTab.get(tabId);
    if (activeId !== undefined) {
      const active = this.byRunId.get(activeId);
      if (active !== undefined && !isTerminalAgentRunState(active.state)) {
        this.transitionRecord(active, 'cancelled', 'TAB_CLOSED');
      }
    }

    for (const record of [...this.byRunId.values()]) {
      if (record.tabId !== tabId) {
        continue;
      }
      this.clearApprovalCorrelation(record);
      this.byRunId.delete(record.runId);
    }
    this.activeByTab.delete(tabId);
    this.tabGenerations.delete(tabId);
  }

  clearAll(): void {
    this.byRunId.clear();
    this.activeByTab.clear();
    this.tabGenerations.clear();
    this.approvalBindings.clear();
  }

  private supersedeActiveRun(tabId: TabId): void {
    const activeId = this.activeByTab.get(tabId);
    if (activeId === undefined) {
      return;
    }
    const existing = this.byRunId.get(activeId);
    if (existing === undefined || isTerminalAgentRunState(existing.state)) {
      this.activeByTab.delete(tabId);
      return;
    }
    this.transitionRecord(existing, 'cancelled', 'SUPERSEDED');
  }

  private transitionCurrent(
    ref: AgentRunRef,
    next: AgentRunState,
    reason: AgentRunTerminalReason,
  ): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    return this.transitionRecord(record, next, reason);
  }

  private transitionRecord(
    record: InternalAgentRun,
    next: AgentRunState,
    reason?: AgentRunTerminalReason,
  ): AgentRunMutationResult {
    this.assertMutableCurrent(record);
    assertAllowedTransition(record.state, next);
    record.state = next;
    if (isTerminalAgentRunState(next)) {
      if (reason === undefined) {
        throw new AgentRunError(
          'AGENT_RUN_INVALID_TRANSITION',
          'Terminal AgentRun states require a reason.',
        );
      }
      record.terminalReason = reason;
      this.detachActive(record);
      this.clearApprovalCorrelation(record);
      this.audit('state-transition', record);
      this.audit('run-terminal', record);
      return applied(record);
    }
    if (reason !== undefined) {
      record.terminalReason = undefined;
    }
    this.audit('state-transition', record);
    return applied(record);
  }

  private blockForBudget(record: InternalAgentRun): AgentRunMutationResult {
    return this.transitionRecord(record, 'blocked', 'STEP_LIMIT_REACHED');
  }

  private resolveLatestMatchingRun(ref: AgentRunRef): InternalAgentRun | undefined {
    const record = this.byRunId.get(ref.runId);
    if (record === undefined) {
      return undefined;
    }
    if (record.tabId !== ref.tabId || record.generation !== ref.generation) {
      return undefined;
    }
    if (this.tabGenerations.get(record.tabId) !== record.generation) {
      return undefined;
    }
    return record;
  }

  private assertMutableCurrent(record: InternalAgentRun): void {
    if (isTerminalAgentRunState(record.state) || this.activeByTab.get(record.tabId) !== record.runId) {
      throw new AgentRunError(
        'AGENT_RUN_INVALID_TRANSITION',
        `AgentRun ${record.runId} is terminal and cannot transition.`,
      );
    }
  }

  private assertState(record: InternalAgentRun, expected: AgentRunState): void {
    if (record.state !== expected) {
      throw new AgentRunError(
        'AGENT_RUN_INVALID_TRANSITION',
        `AgentRun ${record.runId} must be ${expected}, found ${record.state}.`,
      );
    }
  }

  private assertActionAttemptState(record: InternalAgentRun): void {
    if (record.state !== 'running' && record.state !== 'awaiting-approval') {
      throw new AgentRunError(
        'AGENT_RUN_INVALID_TRANSITION',
        `AgentRun ${record.runId} cannot enter an action attempt from ${record.state}.`,
      );
    }
  }

  private assertRunIdAvailable(runId: AgentRunId): void {
    if (this.byRunId.has(runId)) {
      throw new AgentRunError('AGENT_RUN_ID_COLLISION', `runId already exists: ${runId}`);
    }
  }

  private assertApprovalIdAvailable(approvalId: string): void {
    if (this.approvalBindings.has(approvalId)) {
      throw new AgentRunError(
        'APPROVAL_CORRELATION_COLLISION',
        `approvalId already correlated: ${approvalId}`,
      );
    }
  }

  private detachActive(record: InternalAgentRun): void {
    if (this.activeByTab.get(record.tabId) === record.runId) {
      this.activeByTab.delete(record.tabId);
    }
  }

  private clearApprovalCorrelation(record: InternalAgentRun): void {
    const approvalId = record.pendingApprovalId;
    if (approvalId === undefined) {
      return;
    }
    const binding = this.approvalBindings.get(approvalId);
    if (binding?.runId === record.runId) {
      this.approvalBindings.delete(approvalId);
    }
    record.pendingApprovalId = undefined;
  }

  private audit(eventType: AgentRunAuditEventType, record: InternalAgentRun): void {
    if (this.auditSink === undefined) {
      return;
    }
    try {
      this.auditSink.append(buildAgentRunAuditEvent(eventType, toSnapshot(record), this.now()));
    } catch {
      // Observational only. Lifecycle already committed.
    }
  }
}

function hasPrepareBudget(record: InternalAgentRun): boolean {
  return (
    record.actionAttemptCount < MAX_AGENT_LOOP_ACTION_ATTEMPTS &&
    record.approvalCount < MAX_AGENT_LOOP_APPROVALS
  );
}

function assertAllowedTransition(from: AgentRunState, to: AgentRunState): void {
  if (isTerminalAgentRunState(from)) {
    throw new AgentRunError(
      'AGENT_RUN_INVALID_TRANSITION',
      `Cannot transition from terminal state ${from}.`,
    );
  }
  if (from === to && from === 'running') {
    return;
  }
  if (from === 'running') {
    return;
  }
  if (from === 'awaiting-approval') {
    if (to === 'completed' || to === 'awaiting-approval') {
      throw new AgentRunError(
        'AGENT_RUN_INVALID_TRANSITION',
        `Cannot transition from awaiting-approval to ${to}.`,
      );
    }
    return;
  }
  throw new AgentRunError(
    'AGENT_RUN_INVALID_TRANSITION',
    `Cannot transition from ${from} to ${to}.`,
  );
}

function toSnapshot(record: InternalAgentRun): AgentRunSnapshot {
  return Object.freeze({
    runId: record.runId,
    tabId: record.tabId,
    generation: record.generation,
    instruction: record.instruction,
    startedAt: record.startedAt,
    state: record.state,
    modelStepCount: record.modelStepCount,
    actionAttemptCount: record.actionAttemptCount,
    approvalCount: record.approvalCount,
    ...(record.terminalReason !== undefined ? { terminalReason: record.terminalReason } : {}),
    ...(record.lastSuccessfulActionFingerprint !== undefined
      ? { lastSuccessfulActionFingerprint: record.lastSuccessfulActionFingerprint }
      : {}),
  });
}

function applied(record: InternalAgentRun): AgentRunMutationResult {
  return { status: 'applied', snapshot: toSnapshot(record) };
}

function ignored(): AgentRunMutationResult {
  return { status: 'ignored' };
}

function requireTabId(tabId: TabId): TabId {
  if (typeof tabId !== 'string' || tabId.trim().length === 0) {
    throw new AgentRunError('INVALID_TAB_ID', 'tabId must be a non-empty string.');
  }
  return tabId;
}

function requireGeneratedRunId(id: string): AgentRunId {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new AgentRunError('INVALID_AGENT_RUN_ID', 'runId must be a non-empty string.');
  }
  return id;
}

function requireApprovalId(id: string): string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new AgentRunError('INVALID_APPROVAL_ID', 'approvalId must be a non-empty string.');
  }
  return id;
}

function requireFingerprint(fingerprint: string): void {
  if (typeof fingerprint !== 'string' || fingerprint.trim().length === 0) {
    throw new AgentRunError('AGENT_RUN_INVALID_TRANSITION', 'Action fingerprint must be a non-empty string.');
  }
}
