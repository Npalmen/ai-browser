import type {
  ApprovalEvent,
  ApprovalSafeError,
  PendingApprovalView,
} from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';

export type ApprovalUiStatus =
  | 'idle'
  | 'pending'
  | 'deciding'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'failed'
  | 'unknown';

export interface TabApprovalUiState {
  approval?: PendingApprovalView;
  status: ApprovalUiStatus;
  message?: string;
}

export type ApprovalUiState = Record<TabId, TabApprovalUiState>;

export function emptyTabApprovalState(): TabApprovalUiState {
  return { status: 'idle' };
}

export function applyApprovalEvent(state: ApprovalUiState, event: ApprovalEvent): ApprovalUiState {
  if (event.type === 'approval-required') {
    return withTab(state, event.approval.tabId, {
      approval: event.approval,
      status: 'pending',
    });
  }

  const tabId = event.tabId;
  const tab = tabOf(state, tabId);
  if (tab.approval && tab.approval.approvalId !== event.approvalId) {
    return state;
  }

  if (event.type === 'approval-resolved') {
    if (event.decision === 'reject') {
      return withTab(state, tabId, { ...tab, status: 'rejected', message: undefined });
    }
    return withTab(state, tabId, { ...tab, status: 'approved', message: undefined });
  }

  if (event.type === 'execution-started') {
    return withTab(state, tabId, { ...tab, status: 'executing', message: undefined });
  }

  if (event.type === 'execution-completed') {
    return withTab(state, tabId, { ...tab, status: 'completed', message: undefined });
  }

  if (event.type === 'approval-expired') {
    return withTab(state, tabId, { ...tab, status: 'expired', message: undefined });
  }

  if (event.type === 'approval-stale') {
    return withTab(state, tabId, { ...tab, status: 'stale', message: undefined });
  }

  if (event.type === 'execution-failed') {
    const status =
      event.status === 'stale' ? 'stale' : event.status === 'failed' ? 'failed' : 'unknown';
    return withTab(state, tabId, {
      ...tab,
      status,
      message: event.error.message,
    });
  }

  return state;
}

export function markApprovalDeciding(
  state: ApprovalUiState,
  tabId: TabId,
  approvalId: string,
): ApprovalUiState {
  const tab = tabOf(state, tabId);
  if (!tab.approval || tab.approval.approvalId !== approvalId) {
    return state;
  }
  if (tab.status !== 'pending') {
    return state;
  }
  return withTab(state, tabId, { ...tab, status: 'deciding', message: undefined });
}

export function applyApprovalDecideFailure(
  state: ApprovalUiState,
  tabId: TabId,
  approvalId: string,
  error: ApprovalSafeError,
): ApprovalUiState {
  const tab = tabOf(state, tabId);
  if (!tab.approval || tab.approval.approvalId !== approvalId) {
    return state;
  }
  if (tab.status !== 'deciding') {
    return state;
  }
  return withTab(state, tabId, {
    ...tab,
    status: 'pending',
    message: error.message,
  });
}

export function purgeClosedApprovalTabs(
  state: ApprovalUiState,
  liveTabIds: ReadonlySet<TabId>,
): ApprovalUiState {
  const next: ApprovalUiState = {};
  let changed = false;
  for (const [tabId, tabState] of Object.entries(state)) {
    if (liveTabIds.has(tabId)) {
      next[tabId] = tabState;
    } else {
      changed = true;
    }
  }
  return changed ? next : state;
}

export function isApprovalBusy(status: ApprovalUiStatus): boolean {
  return status === 'deciding' || status === 'executing';
}

function tabOf(state: ApprovalUiState, tabId: TabId): TabApprovalUiState {
  return state[tabId] ?? emptyTabApprovalState();
}

function withTab(state: ApprovalUiState, tabId: TabId, tab: TabApprovalUiState): ApprovalUiState {
  return {
    ...state,
    [tabId]: tab,
  };
}
