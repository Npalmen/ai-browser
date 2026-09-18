import type { BrowserAdapter } from '../browser/browser-adapter';
import type { AdapterTargetRef } from '../browser/interaction-adapter-types';
import { TabNotFoundError } from '../browser/tab-registry';
import type { TargetRecord, TargetRegistry } from '../observation/target-registry';
import { ApprovalError } from '../shared/approval-errors';
import type { ExecuteGrant, ExecuteResult, PreparedActionRecordSnapshot } from '../shared/approval-types';
import { InteractionError } from '../shared/interaction-errors';
import type { ApprovalAuditRecorder } from './approval-audit-recorder';
import type { ApprovalManager } from './approval-manager';

const PRE_DISPATCH_STALE_CODES = new Set([
  'TARGET_STALE',
  'TARGET_NOT_FOUND',
  'PAGE_CHANGED',
  'TAB_NOT_FOUND',
]);

export interface ExecuteExecutorDependencies {
  adapter: BrowserAdapter;
  targetRegistry: TargetRegistry;
  manager: ApprovalManager;
  auditRecorder: ApprovalAuditRecorder;
}

export class ExecuteExecutor {
  private readonly inFlightExecutionIds = new Set<string>();

  constructor(private readonly deps: ExecuteExecutorDependencies) {}

  async execute(grant: ExecuteGrant): Promise<ExecuteResult> {
    this.assertDefensiveGrant(grant);
    this.assertExactManagerGrant(grant);

    if (this.inFlightExecutionIds.has(grant.executionId)) {
      throw new ApprovalError('EXECUTE_IN_PROGRESS', 'ExecuteGrant is already being executed.');
    }
    this.inFlightExecutionIds.add(grant.executionId);

    try {
      this.recordExecuteGrantIssuedSafely(grant.approvalId);

      const initialRecord = this.resolveExactCurrentRecord(grant);
      if (initialRecord === null) {
        this.markStaleBeforeDispatchIfExecuting(grant);
        this.recordStaleSafely(grant.approvalId);
        return { executionId: grant.executionId, status: 'stale', errorCode: 'TARGET_STALE' };
      }

      const adapterTarget: AdapterTargetRef = {
        tabId: initialRecord.tabId,
        frameId: initialRecord.frameId,
        backendNodeId: initialRecord.backendNodeId,
        documentRevision: initialRecord.documentRevision,
      };

      try {
        await this.deps.adapter.click({
          target: adapterTarget,
          onBeforeInputDispatch: () => {
            this.assertFinalRegistryAuthority(grant, adapterTarget);
            this.deps.manager.markAdapterPrimitiveInvoked(grant.executionId);
          },
        });
      } catch (error: unknown) {
        return this.handleAdapterClickRejection(grant, error);
      }

      this.recordAttemptedSafely(grant.approvalId);
      return await this.confirmPostClickObservation(grant);
    } finally {
      this.inFlightExecutionIds.delete(grant.executionId);
    }
  }

  private async confirmPostClickObservation(grant: ExecuteGrant): Promise<ExecuteResult> {
    let observation;
    try {
      observation = await this.deps.adapter.observePage(grant.tabId);
    } catch (error: unknown) {
      this.markUnknownIfExecuting(grant);
      this.recordPostObservationFailedSafely(grant.approvalId);
      return {
        executionId: grant.executionId,
        status: 'execution-attempted-state-unknown',
        errorCode: errorCodeOf(error),
      };
    }

    if (observation.tabId !== grant.tabId) {
      this.markUnknownIfExecuting(grant);
      this.recordPostObservationFailedSafely(grant.approvalId);
      return {
        executionId: grant.executionId,
        status: 'execution-attempted-state-unknown',
        errorCode: 'PAGE_CHANGED',
      };
    }

    this.deps.manager.markExecuted(grant.executionId);
    this.recordExecutedSafely(grant.approvalId);
    return { executionId: grant.executionId, status: 'executed' };
  }

  private handleAdapterClickRejection(grant: ExecuteGrant, error: unknown): ExecuteResult {
    const snapshot = this.deps.manager.getSnapshot(grant.approvalId);
    const facts = snapshot?.facts;
    const state = snapshot?.action.state;

    if (facts?.adapterPrimitiveInvoked === true) {
      this.markUnknownIfExecuting(grant);
      this.recordAttemptedSafely(grant.approvalId);
      return {
        executionId: grant.executionId,
        status: 'execution-attempted-state-unknown',
        errorCode: errorCodeOf(error),
      };
    }

    if (state === 'stale') {
      this.recordStaleSafely(grant.approvalId);
      return { executionId: grant.executionId, status: 'stale', errorCode: errorCodeOf(error) };
    }

    if (isPreDispatchStaleError(error)) {
      this.markStaleBeforeDispatchIfExecuting(grant);
      this.recordStaleSafely(grant.approvalId);
      return { executionId: grant.executionId, status: 'stale', errorCode: errorCodeOf(error) };
    }

    this.markFailedBeforeDispatchIfExecuting(grant);
    this.recordExecutionFailedSafely(grant.approvalId);
    return { executionId: grant.executionId, status: 'failed', errorCode: errorCodeOf(error) };
  }

  private assertDefensiveGrant(grant: ExecuteGrant): void {
    if (grant.authority !== 'EXECUTE' || grant.kind !== 'click') {
      throw new ApprovalError('INVALID_EXECUTE_GRANT', 'ExecuteExecutor accepts only EXECUTE click grants.');
    }
  }

  private assertExactManagerGrant(grant: ExecuteGrant): void {
    const snapshot = this.deps.manager.getSnapshot(grant.approvalId);
    if (snapshot === undefined || snapshot.executionGrant === undefined) {
      throw new ApprovalError('INVALID_EXECUTE_GRANT', 'ExecuteGrant is not owned by the approval manager.');
    }

    if (!grantsMatch(grant, snapshot.executionGrant) || !preparedActionMatchesGrant(snapshot, grant)) {
      throw new ApprovalError('INVALID_EXECUTE_GRANT', 'ExecuteGrant does not match manager-owned grant identity.');
    }

    if (
      snapshot.action.state !== 'executing' ||
      snapshot.facts.grantIssued !== true ||
      snapshot.facts.grantClaimed !== true ||
      snapshot.facts.adapterPrimitiveInvoked !== false
    ) {
      throw new ApprovalError(
        'INVALID_APPROVAL_TRANSITION',
        'ExecuteExecutor requires executing manager state with a claimed unused grant.',
      );
    }
  }

  private resolveExactCurrentRecord(grant: ExecuteGrant): TargetRecord | null {
    if (this.deps.targetRegistry.getCurrentObservationId(grant.tabId) !== grant.observationId) {
      return null;
    }

    const record = this.deps.targetRegistry.resolve(grant.tabId, grant.observationId, grant.targetId);
    if (record === null) {
      return null;
    }

    if (
      record.tabId !== grant.tabId ||
      record.observationId !== grant.observationId ||
      record.targetId !== grant.targetId ||
      record.documentRevision !== grant.documentRevision
    ) {
      return null;
    }

    return record;
  }

  private assertFinalRegistryAuthority(grant: ExecuteGrant, adapterTarget: AdapterTargetRef): void {
    if (this.deps.targetRegistry.getCurrentObservationId(grant.tabId) !== grant.observationId) {
      throw new InteractionError('PAGE_CHANGED', 'Target observation was replaced before input dispatch.');
    }

    const record = this.deps.targetRegistry.resolve(grant.tabId, grant.observationId, grant.targetId);
    if (record === null) {
      throw new InteractionError('TARGET_STALE', 'Exact approved target is no longer in the current registry.');
    }

    if (
      record.tabId !== grant.tabId ||
      record.observationId !== grant.observationId ||
      record.targetId !== grant.targetId ||
      record.documentRevision !== grant.documentRevision
    ) {
      throw new InteractionError('TARGET_STALE', 'Exact approved target identity no longer matches the grant.');
    }

    if (record.backendNodeId !== adapterTarget.backendNodeId || record.frameId !== adapterTarget.frameId) {
      throw new InteractionError('TARGET_STALE', 'Exact approved target node identity changed before input dispatch.');
    }
  }

  private markStaleBeforeDispatchIfExecuting(grant: ExecuteGrant): void {
    const snapshot = this.deps.manager.getSnapshot(grant.approvalId);
    if (snapshot?.action.state === 'executing' && snapshot.facts.adapterPrimitiveInvoked === false) {
      this.deps.manager.markStaleBeforeDispatch(grant.executionId);
    }
  }

  private markFailedBeforeDispatchIfExecuting(grant: ExecuteGrant): void {
    const snapshot = this.deps.manager.getSnapshot(grant.approvalId);
    if (snapshot?.action.state === 'executing' && snapshot.facts.adapterPrimitiveInvoked === false) {
      this.deps.manager.markFailedBeforeDispatch(grant.executionId);
    }
  }

  private markUnknownIfExecuting(grant: ExecuteGrant): void {
    const snapshot = this.deps.manager.getSnapshot(grant.approvalId);
    if (snapshot?.action.state === 'executing' && snapshot.facts.adapterPrimitiveInvoked === true) {
      this.deps.manager.markExecutionStateUnknown(grant.executionId);
    }
  }

  private recordExecuteGrantIssuedSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordExecuteGrantIssued(approvalId);
    } catch {
      // Audit failure must not alter EXECUTE authority or trigger retry.
    }
  }

  private recordStaleSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordStale(approvalId);
    } catch {
      // Audit must not retry or un-do browser work.
    }
  }

  private recordAttemptedSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordExecutionAttempted(approvalId);
    } catch {
      // Audit must not retry or un-do browser work.
    }
  }

  private recordExecutionFailedSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordExecutionFailed(approvalId);
    } catch {
      // Audit must not retry or un-do browser work.
    }
  }

  private recordExecutedSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordExecuted(approvalId);
    } catch {
      // Audit must not retry or un-do browser work.
    }
  }

  private recordPostObservationFailedSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordPostObservationFailed(approvalId);
    } catch {
      // Audit must not retry or un-do browser work.
    }
  }
}

function grantsMatch(supplied: ExecuteGrant, owned: ExecuteGrant): boolean {
  return (
    supplied.executionId === owned.executionId &&
    supplied.preparedActionId === owned.preparedActionId &&
    supplied.approvalId === owned.approvalId &&
    supplied.authority === owned.authority &&
    supplied.kind === owned.kind &&
    supplied.tabId === owned.tabId &&
    supplied.observationId === owned.observationId &&
    supplied.documentRevision === owned.documentRevision &&
    supplied.targetId === owned.targetId &&
    supplied.issuedAt === owned.issuedAt
  );
}

function preparedActionMatchesGrant(snapshot: PreparedActionRecordSnapshot, grant: ExecuteGrant): boolean {
  const action = snapshot.action;
  return (
    action.preparedActionId === grant.preparedActionId &&
    action.approvalId === grant.approvalId &&
    action.kind === grant.kind &&
    action.tabId === grant.tabId &&
    action.observationId === grant.observationId &&
    action.documentRevision === grant.documentRevision &&
    action.targetId === grant.targetId
  );
}

function isPreDispatchStaleError(error: unknown): boolean {
  if (error instanceof TabNotFoundError) {
    return true;
  }
  if (error instanceof InteractionError) {
    return PRE_DISPATCH_STALE_CODES.has(error.code);
  }
  return false;
}

function errorCodeOf(error: unknown): string | undefined {
  if (error instanceof TabNotFoundError) {
    return 'TAB_NOT_FOUND';
  }
  if (error instanceof InteractionError) {
    return error.code;
  }
  if (error instanceof ApprovalError) {
    return error.code;
  }
  return undefined;
}
