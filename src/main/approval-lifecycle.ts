import type { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import type { ApprovalManager } from '../approval/approval-manager';
import type {
  ApprovalEvent,
  PendingApprovalView,
  PreparedAction,
} from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';

export interface ApprovalLifecycleDependencies {
  manager: ApprovalManager;
  auditRecorder: ApprovalAuditRecorder;
  emit: (event: ApprovalEvent) => void;
  now?: () => number;
}

export class ApprovalLifecycle {
  private readonly now: () => number;

  constructor(private readonly deps: ApprovalLifecycleDependencies) {
    this.now = deps.now ?? Date.now;
  }

  present(action: PreparedAction): boolean {
    const now = this.now();
    const snapshot = this.deps.manager.getSnapshot(action.approvalId);
    if (snapshot === undefined) {
      return false;
    }
    if (snapshot.action.approvalId !== action.approvalId) {
      return false;
    }
    if (snapshot.action.preparedActionId !== action.preparedActionId) {
      return false;
    }

    if (now >= snapshot.action.expiresAt) {
      this.expireDue(now);
      return false;
    }

    if (snapshot.action.state !== 'pending') {
      return false;
    }

    this.emitSafely({
      type: 'approval-required',
      approval: toPendingApprovalView(snapshot.action),
    });
    this.recordPresentedSafely(action.approvalId);
    return true;
  }

  invalidateTab(tabId: TabId): void {
    const changed = this.deps.manager.invalidateTab(tabId);
    for (const snapshot of changed) {
      this.recordStaleSafely(snapshot.action.approvalId);
      this.emitSafely({
        type: 'approval-stale',
        approvalId: snapshot.action.approvalId,
        tabId: snapshot.action.tabId,
      });
    }
  }

  private expireDue(now: number): void {
    const expired = this.deps.manager.expire(now);
    for (const snapshot of expired) {
      this.recordExpiredSafely(snapshot.action.approvalId);
      this.emitSafely({
        type: 'approval-expired',
        approvalId: snapshot.action.approvalId,
        tabId: snapshot.action.tabId,
      });
    }
  }

  private emitSafely(event: ApprovalEvent): void {
    try {
      this.deps.emit(event);
    } catch {
      // Renderer emission must not roll back approval authority.
    }
  }

  private recordPresentedSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordApprovalPresented(approvalId);
    } catch {
      // Audit must not prevent renderer presentation.
    }
  }

  private recordStaleSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordStale(approvalId);
    } catch {
      // Audit remains observational.
    }
  }

  private recordExpiredSafely(approvalId: string): void {
    try {
      this.deps.auditRecorder.recordExpired(approvalId);
    } catch {
      // Audit remains observational.
    }
  }
}

function toPendingApprovalView(action: PreparedAction): PendingApprovalView {
  return Object.freeze({
    approvalId: action.approvalId,
    tabId: action.tabId,
    category: action.category,
    title: action.summary.title,
    ...(action.summary.description !== undefined ? { description: action.summary.description } : {}),
    ...(action.summary.origin !== undefined ? { origin: action.summary.origin } : {}),
    expiresAt: action.expiresAt,
  });
}
