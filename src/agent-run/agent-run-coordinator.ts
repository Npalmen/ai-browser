import { randomUUID } from 'node:crypto';

import type { TabId } from '../shared/browser-types';
import {
  buildAgentRunAuditEvent,
  type AgentRunAuditEventType,
  type AgentRunAuditSink,
} from './agent-run-audit';
import type { ModelErrorCode } from '../ai/model-errors';
import { AgentRunError } from './agent-run-errors';
import type {
  AgentRunApprovalWaitResult,
  BeginApprovedExecutionResult,
  TrustedAgentApprovalOutcome,
} from './approval-outcome';
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
  cancellationRequested?: AgentRunCancelledReason;
  modelErrorCode?: ModelErrorCode;
  executionTabId: TabId;
  originPopupClickConsumed?: boolean;
}

interface ApprovalWaiter {
  readonly ref: AgentRunRef;
  readonly promise: Promise<AgentRunApprovalWaitResult>;
  readonly resolve: (result: AgentRunApprovalWaitResult) => void;
  settled?: AgentRunApprovalWaitResult;
}

export class AgentRunCoordinator {
  private readonly now: () => number;
  private readonly generateRunId: () => string;
  private readonly auditSink: AgentRunAuditSink | undefined;

  private readonly byRunId = new Map<AgentRunId, InternalAgentRun>();
  private readonly activeByTab = new Map<TabId, AgentRunId>();
  private readonly tabGenerations = new Map<TabId, number>();
  private readonly approvalBindings = new Map<string, AgentRunRef>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();

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
      executionTabId: tabId,
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
    if (isTerminalAgentRunState(record.state) || !this.isActiveOnOwnedTabs(record)) {
      return { status: 'terminal', snapshot };
    }
    return { status: 'current', snapshot };
  }

  getRunRefForApproval(approvalId: string): AgentRunRef | undefined {
    const binding = this.approvalBindings.get(approvalId);
    return binding ? Object.freeze({ ...binding }) : undefined;
  }

  getPendingApprovalId(ref: AgentRunRef): string | undefined {
    const record = this.byRunId.get(ref.runId);
    if (
      record === undefined ||
      record.tabId !== ref.tabId ||
      record.generation !== ref.generation
    ) {
      return undefined;
    }
    return record.pendingApprovalId;
  }

  hasApprovalWaiter(approvalId: string): boolean {
    return this.approvalWaiters.has(approvalId);
  }

  requestCancellationAfterDispatch(
    ref: AgentRunRef,
    reason: AgentRunCancelledReason = 'USER_CANCELLED',
  ): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    if (isTerminalAgentRunState(record.state) || !this.isActiveOnOwnedTabs(record)) {
      return ignored();
    }
    if (record.state !== 'awaiting-approval') {
      return ignored();
    }
    record.cancellationRequested = reason;
    return applied(record);
  }

  markCompleted(ref: AgentRunRef): AgentRunMutationResult {
    return this.transitionCurrent(ref, 'completed', 'COMPLETED');
  }

  markBlocked(ref: AgentRunRef, reason: AgentRunBlockedReason): AgentRunMutationResult {
    return this.transitionCurrent(ref, 'blocked', reason);
  }

  markFailed(
    ref: AgentRunRef,
    reason: AgentRunFailedReason,
    options?: { modelErrorCode?: ModelErrorCode },
  ): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    if (reason === 'MODEL_FAILED' && options?.modelErrorCode !== undefined) {
      record.modelErrorCode = options.modelErrorCode;
    } else {
      record.modelErrorCode = undefined;
    }
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
    if (!this.isActiveOnOwnedTabs(record)) {
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
    const boundRef = toAgentRunRef(toSnapshot(record));
    this.approvalBindings.set(validatedApprovalId, boundRef);
    this.installWaiter(validatedApprovalId, boundRef);
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
    const snapshot = toSnapshot(record);
    this.settleWaiter(approvalId, { status: 'resolved', snapshot });
    return { status: 'applied', snapshot };
  }

  beginApprovedExecution(approvalId: string): BeginApprovedExecutionResult {
    if (typeof approvalId !== 'string' || approvalId.trim().length === 0) {
      return 'unrelated';
    }
    const binding = this.approvalBindings.get(approvalId);
    if (binding === undefined) {
      return this.approvalWaiters.has(approvalId) ? 'ignored' : 'unrelated';
    }
    const record = this.byRunId.get(binding.runId);
    if (
      record === undefined ||
      record.tabId !== binding.tabId ||
      record.generation !== binding.generation ||
      this.tabGenerations.get(record.tabId) !== record.generation
    ) {
      return 'ignored';
    }
    if (isTerminalAgentRunState(record.state) || !this.isActiveOnOwnedTabs(record)) {
      return 'ignored';
    }
    if (record.state !== 'awaiting-approval' || record.pendingApprovalId !== approvalId) {
      return 'ignored';
    }
    if (record.actionAttemptCount >= MAX_AGENT_LOOP_ACTION_ATTEMPTS) {
      this.blockForBudget(record);
      return 'blocked';
    }
    record.actionAttemptCount += 1;
    this.audit('action-attempt-started', record);
    return 'proceed';
  }

  notifyApprovalOutcome(
    approvalId: string,
    outcome: TrustedAgentApprovalOutcome,
  ): AgentRunMutationResult {
    if (typeof approvalId !== 'string' || approvalId.trim().length === 0) {
      return ignored();
    }
    const binding = this.approvalBindings.get(approvalId);
    if (binding === undefined) {
      this.releaseSettledWaiter(approvalId);
      return ignored();
    }
    const record = this.byRunId.get(binding.runId);
    if (
      record === undefined ||
      record.tabId !== binding.tabId ||
      record.generation !== binding.generation ||
      this.tabGenerations.get(record.tabId) !== record.generation
    ) {
      this.releaseSettledWaiter(approvalId);
      return ignored();
    }
    if (isTerminalAgentRunState(record.state) || !this.isActiveOnOwnedTabs(record)) {
      this.releaseSettledWaiter(approvalId);
      return ignored();
    }
    if (record.state !== 'awaiting-approval' || record.pendingApprovalId !== approvalId) {
      this.releaseSettledWaiter(approvalId);
      return ignored();
    }

    let result: AgentRunMutationResult;
    switch (outcome) {
      case 'executed':
        result =
          record.cancellationRequested !== undefined
            ? this.transitionRecord(record, 'cancelled', record.cancellationRequested)
            : this.resumeAfterApprovedExecution(approvalId, record.generation);
        break;
      case 'rejected':
        result = this.transitionRecord(record, 'blocked', 'APPROVAL_REJECTED');
        break;
      case 'expired':
        result = this.transitionRecord(record, 'blocked', 'APPROVAL_EXPIRED');
        break;
      case 'stale':
        result = this.transitionRecord(record, 'blocked', 'ACTION_STALE');
        break;
      case 'failed':
        result = this.transitionRecord(record, 'failed', 'ACTION_FAILED');
        break;
      case 'execution-state-unknown':
        result = this.transitionRecord(record, 'execution-state-unknown', 'EXECUTION_STATE_UNKNOWN');
        break;
      default:
        result = ignored();
        break;
    }
    this.releaseSettledWaiter(approvalId);
    return result;
  }

  waitForApprovalOutcome(
    approvalId: string,
    expectedGeneration: number,
  ): Promise<AgentRunApprovalWaitResult> {
    if (typeof approvalId !== 'string' || approvalId.trim().length === 0) {
      return Promise.resolve({ status: 'ignored' });
    }
    const waiter = this.approvalWaiters.get(approvalId);
    if (waiter === undefined || waiter.ref.generation !== expectedGeneration) {
      return Promise.resolve({ status: 'ignored' });
    }
    return waiter.promise;
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

  assertNotRepeatOriginPopupClick(
    ref: AgentRunRef,
    proposalTabId: TabId,
    proposalKind: 'click' | 'type' | 'select' | 'scroll',
  ): AgentRunMutationResult {
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertState(record, 'running');
    if (
      record.originPopupClickConsumed === true &&
      proposalKind === 'click' &&
      proposalTabId === record.tabId &&
      record.executionTabId !== record.tabId
    ) {
      return this.transitionRecord(record, 'blocked', 'AGENT_LOOP_NO_PROGRESS');
    }
    return applied(record);
  }

  adoptCausalPopup(ref: AgentRunRef, destinationTabId: TabId): AgentRunMutationResult {
    requireTabId(destinationTabId);
    const record = this.resolveLatestMatchingRun(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertMutableCurrent(record);
    this.assertState(record, 'running');
    if (destinationTabId === record.tabId) {
      return ignored();
    }
    if (record.executionTabId === destinationTabId) {
      return applied(record);
    }
    if (record.executionTabId !== record.tabId) {
      return ignored();
    }

    const destinationOwnerId = this.activeByTab.get(destinationTabId);
    if (destinationOwnerId === record.runId) {
      record.executionTabId = destinationTabId;
      record.originPopupClickConsumed = true;
      this.audit('state-transition', record);
      return applied(record);
    }
    if (destinationOwnerId !== undefined) {
      const destinationOwner = this.byRunId.get(destinationOwnerId);
      if (destinationOwner !== undefined && !isTerminalAgentRunState(destinationOwner.state)) {
        return this.transitionRecord(
          record,
          'execution-state-unknown',
          'EXECUTION_STATE_UNKNOWN',
        );
      }
      if (this.activeByTab.get(destinationTabId) === destinationOwnerId) {
        this.activeByTab.delete(destinationTabId);
      }
    }

    record.executionTabId = destinationTabId;
    record.originPopupClickConsumed = true;
    this.activeByTab.set(destinationTabId, record.runId);
    this.audit('state-transition', record);
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
      if (record.tabId !== tabId && record.executionTabId !== tabId) {
        continue;
      }
      this.clearApprovalCorrelation(record);
      this.byRunId.delete(record.runId);
    }
    this.activeByTab.delete(tabId);
    this.tabGenerations.delete(tabId);
  }

  clearAll(): void {
    for (const waiter of this.approvalWaiters.values()) {
      this.finishWaiter(waiter, { status: 'ignored' });
    }
    this.byRunId.clear();
    this.activeByTab.clear();
    this.tabGenerations.clear();
    this.approvalBindings.clear();
    this.approvalWaiters.clear();
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
      const approvalId = record.pendingApprovalId;
      this.clearApprovalCorrelation(record);
      this.audit('state-transition', record);
      this.audit('run-terminal', record);
      const snapshot = toSnapshot(record);
      this.settleWaiter(approvalId, { status: 'resolved', snapshot });
      return { status: 'applied', snapshot };
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
    if (isTerminalAgentRunState(record.state) || !this.isActiveOnOwnedTabs(record)) {
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
    if (
      record.executionTabId !== record.tabId &&
      this.activeByTab.get(record.executionTabId) === record.runId
    ) {
      this.activeByTab.delete(record.executionTabId);
    }
  }

  private isActiveOnOwnedTabs(record: InternalAgentRun): boolean {
    if (this.activeByTab.get(record.tabId) === record.runId) {
      return true;
    }
    return (
      record.executionTabId !== record.tabId &&
      this.activeByTab.get(record.executionTabId) === record.runId
    );
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

  private installWaiter(approvalId: string, ref: AgentRunRef): void {
    const existing = this.approvalWaiters.get(approvalId);
    if (existing !== undefined) {
      this.finishWaiter(existing, { status: 'ignored' });
    }
    let resolve!: (result: AgentRunApprovalWaitResult) => void;
    const promise = new Promise<AgentRunApprovalWaitResult>((res) => {
      resolve = res;
    });
    this.approvalWaiters.set(approvalId, { ref, promise, resolve });
  }

  private settleWaiter(
    approvalId: string | undefined,
    result: AgentRunApprovalWaitResult,
  ): void {
    if (approvalId === undefined) {
      return;
    }
    const waiter = this.approvalWaiters.get(approvalId);
    if (waiter === undefined) {
      return;
    }
    this.finishWaiter(waiter, result);
  }

  private finishWaiter(waiter: ApprovalWaiter, result: AgentRunApprovalWaitResult): void {
    if (waiter.settled !== undefined) {
      return;
    }
    waiter.settled = result;
    waiter.resolve(result);
  }

  private releaseSettledWaiter(approvalId: string): void {
    const waiter = this.approvalWaiters.get(approvalId);
    if (waiter === undefined || waiter.settled === undefined) {
      return;
    }
    this.approvalWaiters.delete(approvalId);
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
    ...(record.modelErrorCode !== undefined ? { modelErrorCode: record.modelErrorCode } : {}),
    ...(record.executionTabId !== record.tabId ? { executionTabId: record.executionTabId } : {}),
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
