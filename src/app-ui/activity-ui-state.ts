import type { AiNativeActivityResult, AiNativeActivitySummary } from '../shared/ai-native-types';
import type { TabId } from '../shared/browser-types';

export type ActivityDeepLink =
  | {
      readonly surface: 'assistant';
      readonly tabId?: TabId;
    }
  | {
      readonly surface: 'workflows';
    };

export interface ActivityRow {
  readonly id: string;
  readonly label: string;
  readonly deepLink: ActivityDeepLink;
  readonly attention: boolean;
}

export interface ActivityUiState {
  readonly open: boolean;
  readonly summary: AiNativeActivitySummary;
  readonly error: string | null;
  readonly loaded: boolean;
}

export function emptyActivityUiState(): ActivityUiState {
  return {
    open: false,
    summary: {
      ask: { activeCount: 0, selectedContextActive: false },
      act: { activeCount: 0 },
      delegate: { active: false, awaitingUserInput: false },
      approval: { pendingCount: 0 },
      workflows: { runningCount: 0, queuedCount: 0, reviewRequiredCount: 0 },
      attention: null,
    },
    error: null,
    loaded: false,
  };
}

export function setActivityOpen(state: ActivityUiState, open: boolean): ActivityUiState {
  return { ...state, open };
}

export function applyActivitySummary(
  state: ActivityUiState,
  result: AiNativeActivityResult,
): ActivityUiState {
  if (!result.ok) {
    return {
      ...state,
      error: result.error.message,
      loaded: true,
    };
  }
  return {
    ...state,
    summary: result.summary,
    error: null,
    loaded: true,
  };
}

export function hasAttentionBadge(summary: AiNativeActivitySummary): boolean {
  return summary.attention !== null;
}

export function hasBackgroundActivity(summary: AiNativeActivitySummary): boolean {
  return (
    summary.ask.activeCount > 0 ||
    summary.act.activeCount > 0 ||
    summary.delegate.active ||
    summary.workflows.runningCount > 0 ||
    summary.workflows.queuedCount > 0 ||
    summary.workflows.reviewRequiredCount > 0
  );
}

export function assistantNeedsAttention(summary: AiNativeActivitySummary): boolean {
  return summary.attention?.kind === 'approval' || summary.attention?.kind === 'delegate-user-input';
}

export function workflowsNeedAttention(summary: AiNativeActivitySummary): boolean {
  return summary.attention?.kind === 'workflow-review' || summary.workflows.reviewRequiredCount > 0;
}

export function activityRows(summary: AiNativeActivitySummary): readonly ActivityRow[] {
  const rows: ActivityRow[] = [];
  if (summary.approval.pendingCount > 0) {
    const tabId = summary.attention?.kind === 'approval' ? summary.attention.tabId : undefined;
    rows.push({
      id: 'approval',
      label:
        summary.approval.pendingCount === 1
          ? 'Approval required'
          : `${summary.approval.pendingCount} approvals required`,
      deepLink: { surface: 'assistant', tabId },
      attention: true,
    });
  }
  if (summary.delegate.awaitingUserInput) {
    rows.push({
      id: 'delegate-input',
      label: 'Needs your input',
      deepLink: { surface: 'assistant' },
      attention: summary.attention?.kind === 'delegate-user-input',
    });
  }
  if (summary.ask.activeCount > 0) {
    rows.push({
      id: 'ask',
      label: summary.ask.selectedContextActive ? 'Ask active (selected tabs)' : 'Ask active',
      deepLink: { surface: 'assistant' },
      attention: false,
    });
  }
  if (summary.act.activeCount > 0) {
    rows.push({
      id: 'act',
      label: 'Act active',
      deepLink: { surface: 'assistant' },
      attention: false,
    });
  }
  if (summary.delegate.active && !summary.delegate.awaitingUserInput) {
    rows.push({
      id: 'delegate',
      label: 'Delegate active',
      deepLink: { surface: 'assistant' },
      attention: false,
    });
  }
  if (summary.workflows.runningCount > 0) {
    rows.push({
      id: 'workflow-running',
      label:
        summary.workflows.runningCount === 1
          ? 'Workflow running'
          : `${summary.workflows.runningCount} workflows running`,
      deepLink: { surface: 'workflows' },
      attention: false,
    });
  }
  if (summary.workflows.queuedCount > 0) {
    rows.push({
      id: 'workflow-queued',
      label: `${summary.workflows.queuedCount} queued`,
      deepLink: { surface: 'workflows' },
      attention: false,
    });
  }
  if (summary.workflows.reviewRequiredCount > 0) {
    rows.push({
      id: 'workflow-review',
      label:
        summary.workflows.reviewRequiredCount === 1
          ? '1 workflow needs review'
          : `${summary.workflows.reviewRequiredCount} workflows need review`,
      deepLink: { surface: 'workflows' },
      attention: summary.attention?.kind === 'workflow-review',
    });
  }
  return rows;
}
