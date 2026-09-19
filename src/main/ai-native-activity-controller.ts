import type { AutonomousTaskView, AutonomousTaskViewState } from '../shared/autonomous-task-types';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import type {
  AiNativeActivityResult,
  AiNativeActivitySummary,
  AiNativeAskActivitySnapshot,
} from '../shared/ai-native-types';
import type { BrowserState, TabId } from '../shared/browser-types';
import type { WorkflowGetStateResult } from '../shared/workflow-product-types';
import { chooseActivityAttention } from './ai-native-activity-attention';

const ACTIVE_DELEGATE_STATES = new Set<AutonomousTaskViewState>([
  'planning',
  'running-subgoal',
  'awaiting-approval',
  'awaiting-user-input',
]);

export interface ActivitySlotOwner {
  readonly kind: 'manual' | 'workflow';
  readonly taskId?: string;
}

export interface AiNativeActivityControllerDependencies {
  getAskSnapshots: () => readonly AiNativeAskActivitySnapshot[];
  hasSelectedContextAsk: () => boolean;
  getTasks: () => readonly AutonomousTaskView[];
  getSlotOwner: () => ActivitySlotOwner | undefined;
  getWorkflowState: () => Promise<WorkflowGetStateResult>;
  getBrowserState: () => BrowserState;
  hasPendingApproval: (tabId: TabId) => boolean;
}

export function emptyActivitySummary(): AiNativeActivitySummary {
  return {
    ask: { activeCount: 0, selectedContextActive: false },
    act: { activeCount: 0 },
    delegate: { active: false, awaitingUserInput: false },
    approval: { pendingCount: 0 },
    workflows: { runningCount: 0, queuedCount: 0, reviewRequiredCount: 0 },
    attention: null,
  };
}

export class AiNativeActivityController {
  private readonly deps: AiNativeActivityControllerDependencies;

  constructor(dependencies: AiNativeActivityControllerDependencies) {
    this.deps = dependencies;
  }

  async getSummary(): Promise<AiNativeActivityResult> {
    try {
      const asks = this.deps.getAskSnapshots();
      const selectedContextActive = this.deps.hasSelectedContextAsk();
      const askActiveCount =
        asks.filter((ask) => ask.mode === 'read').length + (selectedContextActive ? 1 : 0);
      const actActiveCount = asks.filter((ask) => ask.mode === 'interact').length;

      const slot = this.deps.getSlotOwner();
      const delegate = projectDelegate(this.deps.getTasks(), slot);
      const approval = projectApprovals(this.deps.getBrowserState(), this.deps.hasPendingApproval);
      const workflows = await projectWorkflows(this.deps.getWorkflowState(), slot);

      const summary: AiNativeActivitySummary = {
        ask: {
          activeCount: askActiveCount,
          selectedContextActive,
        },
        act: { activeCount: actActiveCount },
        delegate,
        approval: { pendingCount: approval.pendingCount },
        workflows,
        attention: chooseActivityAttention({
          approvalTabId: approval.firstTabId,
          delegateAwaitingUserInput: delegate.awaitingUserInput,
          workflowReviewRequired: workflows.reviewRequiredCount > 0,
        }),
      };
      return { ok: true, summary: Object.freeze(summary) };
    } catch {
      return { ok: false, error: aiNativeSafeError('AI_NATIVE_ACTIVITY_FAILED') };
    }
  }
}

function projectDelegate(
  tasks: readonly AutonomousTaskView[],
  slot: ActivitySlotOwner | undefined,
): AiNativeActivitySummary['delegate'] {
  if (slot?.kind === 'workflow') {
    return { active: false, awaitingUserInput: false };
  }
  const candidates =
    slot?.kind === 'manual' && slot.taskId
      ? tasks.filter((task) => task.taskId === slot.taskId)
      : slot?.kind === 'manual'
        ? tasks
        : tasks.filter((task) => ACTIVE_DELEGATE_STATES.has(task.state));
  const activeTasks = candidates.filter((task) => ACTIVE_DELEGATE_STATES.has(task.state));
  const awaitingUserInput = activeTasks.some((task) => task.state === 'awaiting-user-input');
  const reservedWithoutTask = slot?.kind === 'manual' && slot.taskId === undefined;
  return {
    active: activeTasks.length > 0 || reservedWithoutTask,
    awaitingUserInput,
  };
}

function projectApprovals(
  browserState: BrowserState,
  hasPendingApproval: (tabId: TabId) => boolean,
): { pendingCount: number; firstTabId: TabId | null } {
  let pendingCount = 0;
  let firstTabId: TabId | null = null;
  for (const tab of browserState.tabs) {
    if (!hasPendingApproval(tab.id)) {
      continue;
    }
    pendingCount += 1;
    if (firstTabId === null) {
      firstTabId = tab.id;
    }
  }
  return { pendingCount, firstTabId };
}

async function projectWorkflows(
  getState: Promise<WorkflowGetStateResult>,
  slot: ActivitySlotOwner | undefined,
): Promise<AiNativeActivitySummary['workflows']> {
  const state = await getState;
  if (!state.ok || state.status !== 'ready') {
    return { runningCount: 0, queuedCount: 0, reviewRequiredCount: 0 };
  }
  let runningCount = 0;
  let queuedCount = 0;
  let reviewRequiredCount = 0;
  for (const workflow of state.workflows) {
    if (workflow.running) {
      runningCount += 1;
    }
    queuedCount += workflow.queuedCount;
    if (workflow.reviewRequired) {
      reviewRequiredCount += 1;
    }
  }
  if (slot?.kind === 'workflow' && runningCount === 0) {
    runningCount = 1;
  }
  return { runningCount, queuedCount, reviewRequiredCount };
}
