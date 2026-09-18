import { randomUUID } from 'node:crypto';

import { ApprovalError } from '../shared/approval-errors';
import {
  PREPARED_ACTION_TTL_MS,
  type ApprovalDecision,
  type ApprovalDecisionValue,
  type ApprovalExecutionFacts,
  type ExecuteGrant,
  type PreparePreparedActionInput,
  type PreparedAction,
  type PreparedActionRecordSnapshot,
  type PreparedActionState,
  type PreparedActionSummary,
} from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';
import type { ObservationId } from '../shared/observation-types';

export interface ApprovalManagerDependencies {
  now?: () => number;
  generatePreparedActionId?: () => string;
  generateApprovalId?: () => string;
  generateExecutionId?: () => string;
}

interface MutableExecutionFacts {
  grantIssued: boolean;
  grantClaimed: boolean;
  adapterPrimitiveInvoked: boolean;
  postObservationSucceeded: boolean;
}

interface InternalApprovalRecord {
  preparedActionId: string;
  approvalId: string;
  tabId: TabId;
  observationId: ObservationId;
  documentRevision: PreparedAction['documentRevision'];
  targetId: PreparedAction['targetId'];
  category: PreparedAction['category'];
  summary: PreparedActionSummary;
  createdAt: number;
  expiresAt: number;
  state: PreparedActionState;
  decision?: ApprovalDecision;
  executionGrant?: ExecuteGrant;
  facts: MutableExecutionFacts;
}

export class ApprovalManager {
  private readonly now: () => number;
  private readonly generatePreparedActionId: () => string;
  private readonly generateApprovalId: () => string;
  private readonly generateExecutionId: () => string;

  private readonly byApprovalId = new Map<string, InternalApprovalRecord>();
  private readonly byPreparedActionId = new Map<string, InternalApprovalRecord>();
  private readonly byExecutionId = new Map<string, InternalApprovalRecord>();
  /** Pending or approved (unclaimed) approvalId per tab. */
  private readonly unresolvedByTab = new Map<TabId, string>();

  constructor(deps: ApprovalManagerDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.generatePreparedActionId = deps.generatePreparedActionId ?? randomUUID;
    this.generateApprovalId = deps.generateApprovalId ?? randomUUID;
    this.generateExecutionId = deps.generateExecutionId ?? randomUUID;
  }

  prepare(input: PreparePreparedActionInput): PreparedAction {
    this.staleUnresolvedForTab(input.tabId);

    const createdAt = this.now();
    const preparedActionId = requireGeneratedId(
      this.generatePreparedActionId(),
      'preparedActionId',
    );
    const approvalId = requireGeneratedId(this.generateApprovalId(), 'approvalId');

    const record: InternalApprovalRecord = {
      preparedActionId,
      approvalId,
      tabId: input.tabId,
      observationId: input.observationId,
      documentRevision: input.documentRevision,
      targetId: input.targetId,
      category: input.category,
      summary: freezeSummary(input.summary),
      createdAt,
      expiresAt: createdAt + PREPARED_ACTION_TTL_MS,
      state: 'pending',
      facts: {
        grantIssued: false,
        grantClaimed: false,
        adapterPrimitiveInvoked: false,
        postObservationSucceeded: false,
      },
    };

    this.byApprovalId.set(approvalId, record);
    this.byPreparedActionId.set(preparedActionId, record);
    this.unresolvedByTab.set(input.tabId, approvalId);

    return this.toAction(record);
  }

  decide(approvalId: string, decision: ApprovalDecisionValue): ApprovalDecision {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'Decision must be approve or reject.',
      );
    }

    const record = this.requireApproval(approvalId);
    this.expireIfDue(record, this.now());

    if (record.state === 'expired') {
      throw new ApprovalError('APPROVAL_EXPIRED', 'Approval has expired.');
    }
    if (record.state === 'stale') {
      throw new ApprovalError('APPROVAL_STALE', 'Approval is stale.');
    }
    if (record.state !== 'pending') {
      throw new ApprovalError(
        record.decision ? 'APPROVAL_ALREADY_DECIDED' : 'INVALID_APPROVAL_TRANSITION',
        'Approval is no longer pending.',
      );
    }

    const recorded: ApprovalDecision = Object.freeze({
      approvalId: record.approvalId,
      preparedActionId: record.preparedActionId,
      decision,
      decidedAt: this.now(),
    });

    record.decision = recorded;

    if (decision === 'reject') {
      record.state = 'rejected';
      this.clearUnresolved(record);
      return cloneDecision(recorded);
    }

    record.state = 'approved';
    record.facts.grantIssued = true;
    return cloneDecision(recorded);
  }

  claimExecuteGrant(approvalId: string): ExecuteGrant {
    const record = this.requireApproval(approvalId);
    this.expireIfDue(record, this.now());

    if (record.facts.grantClaimed || record.executionGrant !== undefined) {
      throw new ApprovalError('EXECUTE_GRANT_ALREADY_CLAIMED', 'ExecuteGrant already claimed.');
    }
    if (record.state === 'expired') {
      throw new ApprovalError('APPROVAL_EXPIRED', 'Approval has expired.');
    }
    if (record.state === 'stale') {
      throw new ApprovalError('APPROVAL_STALE', 'Approval is stale.');
    }
    if (record.state !== 'approved') {
      throw new ApprovalError('INVALID_APPROVAL_TRANSITION', 'ExecuteGrant requires an approved action.');
    }

    const issuedAt = this.now();
    const executionId = requireGeneratedId(this.generateExecutionId(), 'executionId');
    const grant: ExecuteGrant = Object.freeze({
      executionId,
      preparedActionId: record.preparedActionId,
      approvalId: record.approvalId,
      authority: 'EXECUTE',
      kind: 'click',
      tabId: record.tabId,
      observationId: record.observationId,
      documentRevision: record.documentRevision,
      targetId: record.targetId,
      issuedAt,
    });

    record.executionGrant = grant;
    record.facts.grantClaimed = true;
    record.state = 'executing';
    this.clearUnresolved(record);
    this.byExecutionId.set(executionId, record);

    return cloneGrant(grant);
  }

  markAdapterPrimitiveInvoked(executionId: string): void {
    const record = this.requireExecution(executionId);
    this.assertExecutingPreDispatch(record);
    record.facts.adapterPrimitiveInvoked = true;
  }

  markStaleBeforeDispatch(executionId: string): void {
    const record = this.requireExecution(executionId);
    this.assertExecutingPreDispatch(record);
    record.state = 'stale';
  }

  markFailedBeforeDispatch(executionId: string): void {
    const record = this.requireExecution(executionId);
    this.assertExecutingPreDispatch(record);
    record.state = 'failed';
  }

  markExecuted(executionId: string): void {
    const record = this.requireExecution(executionId);
    this.assertExecutingPostDispatch(record);
    record.facts.postObservationSucceeded = true;
    record.state = 'executed';
  }

  markExecutionStateUnknown(executionId: string): void {
    const record = this.requireExecution(executionId);
    this.assertExecutingPostDispatch(record);
    record.facts.postObservationSucceeded = false;
    record.state = 'execution-attempted-state-unknown';
  }

  markStale(approvalId: string): void {
    const record = this.requireApproval(approvalId);
    if (record.state !== 'pending' && record.state !== 'approved') {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'Pre-claim stale is only valid from pending or approved.',
      );
    }
    record.state = 'stale';
    this.clearUnresolved(record);
  }

  expire(now: number = this.now()): ReadonlyArray<PreparedActionRecordSnapshot> {
    const expired: PreparedActionRecordSnapshot[] = [];
    for (const record of this.byApprovalId.values()) {
      if (this.expireIfDue(record, now)) {
        expired.push(this.toSnapshot(record));
      }
    }
    return Object.freeze(expired);
  }

  invalidateTab(tabId: TabId): ReadonlyArray<PreparedActionRecordSnapshot> {
    const changed: PreparedActionRecordSnapshot[] = [];
    for (const record of this.byApprovalId.values()) {
      if (record.tabId !== tabId) {
        continue;
      }
      if (this.staleForInvalidation(record)) {
        changed.push(this.toSnapshot(record));
      }
    }
    return Object.freeze(changed);
  }

  invalidateObservation(
    tabId: TabId,
    invalidatedObservationId: ObservationId,
  ): ReadonlyArray<PreparedActionRecordSnapshot> {
    const changed: PreparedActionRecordSnapshot[] = [];
    for (const record of this.byApprovalId.values()) {
      if (record.tabId !== tabId || record.observationId !== invalidatedObservationId) {
        continue;
      }
      if (this.staleForInvalidation(record)) {
        changed.push(this.toSnapshot(record));
      }
    }
    return Object.freeze(changed);
  }

  getByApprovalId(approvalId: string): PreparedAction | undefined {
    const record = this.byApprovalId.get(approvalId);
    return record ? this.toAction(record) : undefined;
  }

  getByPreparedActionId(preparedActionId: string): PreparedAction | undefined {
    const record = this.byPreparedActionId.get(preparedActionId);
    return record ? this.toAction(record) : undefined;
  }

  getPendingForTab(tabId: TabId): PreparedAction | undefined {
    for (const record of this.byApprovalId.values()) {
      if (record.tabId === tabId && record.state === 'pending') {
        return this.toAction(record);
      }
    }
    return undefined;
  }

  getSnapshot(approvalId: string): PreparedActionRecordSnapshot | undefined {
    const record = this.byApprovalId.get(approvalId);
    return record ? this.toSnapshot(record) : undefined;
  }

  private staleUnresolvedForTab(tabId: TabId): void {
    const existingId = this.unresolvedByTab.get(tabId);
    if (existingId === undefined) {
      return;
    }
    const existing = this.byApprovalId.get(existingId);
    if (existing === undefined) {
      this.unresolvedByTab.delete(tabId);
      return;
    }
    if (existing.state === 'pending' || existing.state === 'approved') {
      existing.state = 'stale';
      this.clearUnresolved(existing);
    }
  }

  private staleForInvalidation(record: InternalApprovalRecord): boolean {
    if (record.state === 'pending' || record.state === 'approved') {
      record.state = 'stale';
      this.clearUnresolved(record);
      return true;
    }
    if (record.state === 'executing' && record.facts.adapterPrimitiveInvoked === false) {
      record.state = 'stale';
      return true;
    }
    return false;
  }

  private expireIfDue(record: InternalApprovalRecord, now: number): boolean {
    if (record.state !== 'pending' && record.state !== 'approved') {
      return false;
    }
    if (now < record.expiresAt) {
      return false;
    }
    record.state = 'expired';
    this.clearUnresolved(record);
    return true;
  }

  private clearUnresolved(record: InternalApprovalRecord): void {
    if (this.unresolvedByTab.get(record.tabId) === record.approvalId) {
      this.unresolvedByTab.delete(record.tabId);
    }
  }

  private assertExecutingPreDispatch(record: InternalApprovalRecord): void {
    if (record.facts.adapterPrimitiveInvoked) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'Post-dispatch execution cannot become stale, failed, rejected, or expired.',
      );
    }
    if (record.state !== 'executing' || record.facts.grantClaimed !== true) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'Pre-dispatch execution marks require executing with a claimed grant and no adapter dispatch.',
      );
    }
  }

  private assertExecutingPostDispatch(record: InternalApprovalRecord): void {
    if (
      record.state !== 'executing' ||
      record.facts.grantClaimed !== true ||
      record.facts.adapterPrimitiveInvoked !== true
    ) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'Executed/unknown marks require a claimed grant after adapter dispatch.',
      );
    }
  }

  private requireApproval(approvalId: string): InternalApprovalRecord {
    const record = this.byApprovalId.get(approvalId);
    if (record === undefined) {
      throw new ApprovalError('APPROVAL_NOT_FOUND', `Approval not found: ${approvalId}`);
    }
    return record;
  }

  private requireExecution(executionId: string): InternalApprovalRecord {
    const record = this.byExecutionId.get(executionId);
    if (record === undefined) {
      throw new ApprovalError('EXECUTION_NOT_FOUND', `Execution not found: ${executionId}`);
    }
    return record;
  }

  private toAction(record: InternalApprovalRecord): PreparedAction {
    return Object.freeze({
      preparedActionId: record.preparedActionId,
      approvalId: record.approvalId,
      kind: 'click',
      tabId: record.tabId,
      observationId: record.observationId,
      documentRevision: record.documentRevision,
      targetId: record.targetId,
      category: record.category,
      summary: freezeSummary(record.summary),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      state: record.state,
    });
  }

  private toFacts(record: InternalApprovalRecord): ApprovalExecutionFacts {
    return Object.freeze({
      grantIssued: record.facts.grantIssued,
      grantClaimed: record.facts.grantClaimed,
      adapterPrimitiveInvoked: record.facts.adapterPrimitiveInvoked,
      postObservationSucceeded: record.facts.postObservationSucceeded,
    });
  }

  private toSnapshot(record: InternalApprovalRecord): PreparedActionRecordSnapshot {
    return Object.freeze({
      action: this.toAction(record),
      ...(record.decision !== undefined ? { decision: cloneDecision(record.decision) } : {}),
      ...(record.executionGrant !== undefined ? { executionGrant: cloneGrant(record.executionGrant) } : {}),
      facts: this.toFacts(record),
    });
  }
}

function freezeSummary(summary: PreparedActionSummary): PreparedActionSummary {
  return Object.freeze({
    title: summary.title,
    ...(summary.description !== undefined ? { description: summary.description } : {}),
    ...(summary.origin !== undefined ? { origin: summary.origin } : {}),
  });
}

function cloneDecision(decision: ApprovalDecision): ApprovalDecision {
  return Object.freeze({
    approvalId: decision.approvalId,
    preparedActionId: decision.preparedActionId,
    decision: decision.decision,
    decidedAt: decision.decidedAt,
  });
}

function cloneGrant(grant: ExecuteGrant): ExecuteGrant {
  return Object.freeze({
    executionId: grant.executionId,
    preparedActionId: grant.preparedActionId,
    approvalId: grant.approvalId,
    authority: 'EXECUTE',
    kind: 'click',
    tabId: grant.tabId,
    observationId: grant.observationId,
    documentRevision: grant.documentRevision,
    targetId: grant.targetId,
    issuedAt: grant.issuedAt,
  });
}

function requireGeneratedId(id: string, label: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new ApprovalError('INVALID_APPROVAL_TRANSITION', `${label} must be a non-empty string.`);
  }
  return id;
}
