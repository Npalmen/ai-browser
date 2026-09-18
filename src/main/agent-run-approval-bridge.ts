import type { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import type {
  AgentRunApprovalPort,
  AgentRunApprovalPrepareResult,
} from '../agent-run/approval-pause-port';
import type { AgentRunRef } from '../agent-run/agent-run-types';
import type { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import type { ApprovalManager } from '../approval/approval-manager';
import type { PrepareActionService } from '../approval/prepare-action-service';
import type { BoundInteractionProposal } from '../shared/interaction-types';
import type { ApprovalEvent } from '../shared/approval-types';
import type { PageObservation } from '../shared/observation-types';
import type { ApprovalLifecycle } from './approval-lifecycle';

export interface AgentRunApprovalBridgeDependencies {
  coordinator: AgentRunCoordinator;
  prepareActionService: Pick<PrepareActionService, 'prepare'>;
  lifecycle: Pick<ApprovalLifecycle, 'present'>;
  manager: Pick<ApprovalManager, 'getSnapshot' | 'getByApprovalId' | 'markStale'>;
  auditRecorder: Pick<ApprovalAuditRecorder, 'recordStale'>;
  emit: (event: ApprovalEvent) => void;
}

export class AgentRunApprovalBridge implements AgentRunApprovalPort {
  constructor(private readonly deps: AgentRunApprovalBridgeDependencies) {}

  prepareAndPresent(input: {
    ref: AgentRunRef;
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): AgentRunApprovalPrepareResult {
    if (!this.deps.coordinator.isCurrentRun(input.ref) || input.signal?.aborted) {
      return { status: 'ignored' };
    }
    if (input.proposal.kind !== 'click') {
      return { status: 'failed' };
    }
    if (!this.deps.coordinator.canPrepareAnotherAction(input.ref)) {
      return { status: 'failed' };
    }

    let action;
    try {
      action = this.deps.prepareActionService.prepare({
        proposal: input.proposal,
        observation: input.observation,
      });
    } catch {
      return { status: 'failed' };
    }

    if (!this.deps.coordinator.isCurrentRun(input.ref) || input.signal?.aborted) {
      this.invalidateExactApproval(action.approvalId, false);
      return { status: 'ignored' };
    }

    const presented = this.deps.lifecycle.present(action);

    if (!this.deps.coordinator.isCurrentRun(input.ref)) {
      this.invalidateExactApproval(action.approvalId, presented);
      return { status: 'ignored' };
    }

    if (!presented) {
      const state = this.deps.manager.getByApprovalId(action.approvalId)?.state;
      if (state === 'expired') {
        return { status: 'expired' };
      }
      if (state === 'stale') {
        return { status: 'stale' };
      }
      this.invalidateExactApproval(action.approvalId, false);
      return { status: 'failed' };
    }

    const correlated = this.deps.coordinator.presentApproval(input.ref, action.approvalId);
    if (correlated.status === 'ignored') {
      this.invalidateExactApproval(action.approvalId, true);
      return { status: 'ignored' };
    }
    if (correlated.snapshot.state !== 'awaiting-approval') {
      this.invalidateExactApproval(action.approvalId, true);
      return { status: 'failed' };
    }

    return {
      status: 'awaiting-approval',
      approvalId: action.approvalId,
    };
  }

  private invalidateExactApproval(approvalId: string, emitStaleEvent: boolean): void {
    const snapshot = this.deps.manager.getSnapshot(approvalId);
    if (snapshot === undefined) {
      return;
    }
    const previousState = snapshot.action.state;
    if (previousState === 'pending' || previousState === 'approved') {
      try {
        this.deps.manager.markStale(approvalId);
      } catch {
        return;
      }
      try {
        this.deps.auditRecorder.recordStale(approvalId);
      } catch {
        // Audit remains observational.
      }
    } else if (!emitStaleEvent) {
      return;
    }

    if (emitStaleEvent) {
      this.emitSafely({
        type: 'approval-stale',
        approvalId,
        tabId: snapshot.action.tabId,
      });
    }
  }

  private emitSafely(event: ApprovalEvent): void {
    try {
      this.deps.emit(event);
    } catch {
      // Renderer emission must not roll back prepared-action cleanup.
    }
  }
}
