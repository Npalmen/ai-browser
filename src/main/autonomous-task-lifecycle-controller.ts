import type { AgentRunCancelledReason } from '../agent-run/agent-run-types';
import type { BrowserTabCreatedEvent } from '../browser/tab-creation';
import type { TabId } from '../shared/browser-types';
import {
  AutonomousTaskChildRunExecutor,
  type AutonomousTaskChildLifecycleIntent,
  type AutonomousTaskChildRunResult,
} from '../autonomous-task/autonomous-task-child-run-executor';
import { AutonomousTaskCoordinator } from '../autonomous-task/autonomous-task-coordinator';
import { AutonomousTaskError } from '../autonomous-task/autonomous-task-errors';
import { AutonomousTaskPlannerExecutor } from '../autonomous-task/autonomous-task-planner-executor';
import {
  MAX_AUTONOMOUS_TASK_OWNED_TABS,
  isActiveAutonomousTaskState,
  isAutonomousTaskApplied,
  isTerminalAutonomousTaskState,
  toAutonomousTaskRef,
  type AutonomousTaskMutationResult,
  type AutonomousTaskRef,
  type AutonomousTaskSnapshot,
} from '../autonomous-task/autonomous-task-types';
import { TaskTabStateRegistry } from '../autonomous-task/task-tab-state-registry';

export interface TrustedBrowserStatePort {
  getBrowserState(): { readonly activeTabId: TabId };
}

export interface ManualActActivityPort {
  isActive(tabId: TabId): boolean;
}

export interface AutonomousTaskLifecycleControllerDependencies {
  coordinator: AutonomousTaskCoordinator;
  tabState: TaskTabStateRegistry;
  planner: AutonomousTaskPlannerExecutor;
  childRuns: AutonomousTaskChildRunExecutor;
  browser: TrustedBrowserStatePort;
  manualRuns: ManualActActivityPort;
}

/**
 * Trusted-main task workspace lifecycle. Does not plan, click, approve, or emit UI.
 */
export class AutonomousTaskLifecycleController {
  private readonly coordinator: AutonomousTaskCoordinator;
  private readonly tabState: TaskTabStateRegistry;
  private readonly planner: AutonomousTaskPlannerExecutor;
  private readonly childRuns: AutonomousTaskChildRunExecutor;
  private readonly browser: TrustedBrowserStatePort;
  private readonly manualRuns: ManualActActivityPort;

  constructor(deps: AutonomousTaskLifecycleControllerDependencies) {
    this.coordinator = deps.coordinator;
    this.tabState = deps.tabState;
    this.planner = deps.planner;
    this.childRuns = deps.childRuns;
    this.browser = deps.browser;
    this.manualRuns = deps.manualRuns;
  }

  startOnCurrentTab(objective: string): AutonomousTaskSnapshot {
    let activeTabId: TabId;
    try {
      activeTabId = this.browser.getBrowserState().activeTabId;
    } catch {
      throw new AutonomousTaskError('INVALID_TAB_ID', 'Trusted browser state has no active tab.');
    }
    if (typeof activeTabId !== 'string' || activeTabId.trim().length === 0) {
      throw new AutonomousTaskError('INVALID_TAB_ID', 'Trusted browser state has no active tab.');
    }
    if (this.manualRuns.isActive(activeTabId)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        'Cannot start an AutonomousTask while a manual Act is active on the current tab.',
      );
    }
    const snapshot = this.coordinator.startTask(activeTabId, objective);
    const owned = this.coordinator.getOwnedTabs(snapshot.taskId)[0];
    if (owned === undefined) {
      throw new AutonomousTaskError(
        'TASK_TAB_NOT_OWNED',
        'Starting tab was not recorded in the task workspace.',
      );
    }
    this.tabState.initializeOwnedTab(snapshot.taskId, owned.alias, owned.tabId);
    return snapshot;
  }

  async pause(
    ref: AutonomousTaskRef,
    intent: AutonomousTaskChildLifecycleIntent = 'pause',
  ): Promise<AutonomousTaskMutationResult> {
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status === 'missing' || inspected.status === 'superseded') {
      return { status: 'ignored' };
    }
    if (inspected.status === 'terminal') {
      return { status: 'ignored' };
    }
    if (inspected.status === 'paused' || inspected.snapshot.state === 'paused') {
      return { status: 'applied', snapshot: inspected.snapshot };
    }

    const snapshot = inspected.snapshot;
    if (snapshot.state === 'planning') {
      await this.planner.cancelAndWait(ref);
      return this.pauseIfNonterminal(ref);
    }
    if (snapshot.state === 'running-subgoal' || snapshot.state === 'awaiting-approval') {
      const childResult = await this.childRuns.cancelActiveChildForLifecycle(
        ref,
        intent === 'trusted-navigation' ? 'TRUSTED_CHROME_NAVIGATION' : 'USER_CANCELLED',
        intent,
      );
      return this.pauseAfterChild(ref, childResult);
    }
    if (snapshot.state === 'awaiting-user-input') {
      return this.pauseIfNonterminal(ref);
    }
    return this.pauseIfNonterminal(ref);
  }

  async stop(ref: AutonomousTaskRef): Promise<AutonomousTaskMutationResult> {
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status === 'missing' || inspected.status === 'superseded') {
      return { status: 'ignored' };
    }
    if (inspected.status === 'terminal') {
      return { status: 'ignored' };
    }
    if (inspected.status === 'paused' || inspected.snapshot.state === 'paused') {
      return this.cancelIfNonterminal(ref);
    }

    const snapshot = inspected.snapshot;
    if (snapshot.state === 'planning') {
      await this.planner.cancelAndWait(ref);
      return this.cancelIfNonterminal(ref);
    }
    if (snapshot.state === 'running-subgoal' || snapshot.state === 'awaiting-approval') {
      const childResult = await this.childRuns.cancelActiveChildForLifecycle(
        ref,
        'USER_CANCELLED',
        'stop',
      );
      return this.stopAfterChild(ref, childResult);
    }
    if (snapshot.state === 'awaiting-user-input') {
      return this.cancelIfNonterminal(ref);
    }
    return this.cancelIfNonterminal(ref);
  }

  resume(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status === 'missing' || inspected.status === 'superseded' || inspected.status === 'terminal') {
      return { status: 'ignored' };
    }
    if (inspected.status !== 'paused') {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${ref.taskId} must be paused to resume.`,
      );
    }
    const snapshot = inspected.snapshot;
    if (this.planner.hasActive(snapshot.taskId) || this.childRuns.getActiveChild(snapshot.taskId) !== undefined) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        'Cannot resume while planner or child work is still active.',
      );
    }
    if (this.coordinator.getOwnedTabs(snapshot.taskId).length === 0) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        'Cannot resume a paused AutonomousTask with zero owned tabs.',
      );
    }
    for (const tab of this.coordinator.getOwnedTabs(snapshot.taskId)) {
      if (this.manualRuns.isActive(tab.tabId)) {
        throw new AutonomousTaskError(
          'AUTONOMOUS_TASK_INVALID_TRANSITION',
          'Cannot resume while a manual Act is active on a task-owned tab.',
        );
      }
    }
    return this.coordinator.resumeTask(ref);
  }

  async beforeTrustedChromeNavigation(tabId: TabId): Promise<void> {
    const owner = this.coordinator.getTabOwner(tabId);
    if (owner === undefined) {
      return;
    }
    const task = this.coordinator.getTask(owner.taskId);
    if (task === undefined || isTerminalAutonomousTaskState(task.state)) {
      return;
    }
    if (task.state === 'paused') {
      return;
    }
    await this.pause(toAutonomousTaskRef(task), 'trusted-navigation');
  }

  handleGenericNavigation(tabId: TabId): void {
    this.tabState.incrementForTab(tabId);
  }

  async handleTabCreated(event: BrowserTabCreatedEvent): Promise<void> {
    if (!this.shouldAdoptPopup(event)) {
      return;
    }
    const owner = this.coordinator.getTabOwner(event.sourceTabId!);
    if (owner === undefined) {
      return;
    }
    const task = this.coordinator.getTask(owner.taskId);
    if (task === undefined) {
      return;
    }
    const ref = toAutonomousTaskRef(task);
    const child = this.childRuns.getActiveChild(task.taskId);
    if (
      task.state === 'awaiting-approval' &&
      task.ownedTabCount >= MAX_AUTONOMOUS_TASK_OWNED_TABS
    ) {
      if (child === undefined) {
        return;
      }
      const childResult = await this.childRuns.cancelActiveChildForLifecycle(
        child.taskRef,
        'USER_CANCELLED',
        'task-budget',
      );
      this.blockBudgetIfStillNonterminal(ref, childResult);
      return;
    }
    const adopted = this.coordinator.adoptTaskTab(ref, event.tabId, 'task-created');
    if (adopted.status === 'ignored') {
      return;
    }
    if (isAutonomousTaskApplied(adopted) && isTerminalAutonomousTaskState(adopted.snapshot.state)) {
      this.tabState.releaseTask(task.taskId);
      if (child !== undefined) {
        await this.childRuns.cancelActiveChildForLifecycle(
          child.taskRef,
          'USER_CANCELLED',
          'task-budget',
        );
      }
      return;
    }
    const created = this.coordinator.getTabOwner(event.tabId);
    if (created !== undefined) {
      this.tabState.initializeOwnedTab(created.taskId, created.alias, created.tabId);
    }
  }

  async handleTabClosed(tabId: TabId): Promise<void> {
    const owner = this.coordinator.getTabOwner(tabId);
    if (owner === undefined) {
      return;
    }
    const task = this.coordinator.getTask(owner.taskId);
    if (task === undefined) {
      this.tabState.releaseTab(tabId);
      return;
    }
    const ref = toAutonomousTaskRef(task);
    const child = this.childRuns.getActiveChild(task.taskId);

    if (child !== undefined && child.tabId === tabId && isActiveAutonomousTaskState(task.state)) {
      const childResult = await this.childRuns.cancelActiveChildForLifecycle(
        ref,
        'TAB_CLOSED',
        'tab-close',
      );
      this.blockIfStillNonterminal(ref, childResult);
      return;
    }

    if (isTerminalAutonomousTaskState(task.state)) {
      this.tabState.releaseTab(tabId);
      return;
    }

    const released = this.coordinator.releaseTaskTab(ref, owner.alias);
    this.tabState.releaseTab(tabId);
    if (released.status === 'ignored') {
      return;
    }
    const remaining = this.coordinator.getOwnedTabs(task.taskId).length;
    if (remaining === 0 && isActiveAutonomousTaskState(released.snapshot.state)) {
      const blocked = this.coordinator.markBlocked(ref, 'TAB_UNAVAILABLE');
      if (isAutonomousTaskApplied(blocked)) {
        this.tabState.releaseTask(task.taskId);
      }
    }
  }

  canStartManualAct(tabId: TabId): boolean {
    const owner = this.coordinator.getTabOwner(tabId);
    if (owner === undefined) {
      return true;
    }
    const task = this.coordinator.getTask(owner.taskId);
    if (task === undefined || isTerminalAutonomousTaskState(task.state) || task.state === 'paused') {
      return true;
    }
    return false;
  }

  private shouldAdoptPopup(event: BrowserTabCreatedEvent): boolean {
    if (event.cause !== 'website-popup') {
      return false;
    }
    if (event.causedByAgentInputDispatch !== true) {
      return false;
    }
    if (event.sourceTabId === undefined) {
      return false;
    }
    const owner = this.coordinator.getTabOwner(event.sourceTabId);
    if (owner === undefined) {
      return false;
    }
    const task = this.coordinator.getTask(owner.taskId);
    if (task === undefined || !isActiveAutonomousTaskState(task.state)) {
      return false;
    }
    const child = this.childRuns.getActiveChild(task.taskId);
    if (child === undefined) {
      return false;
    }
    return child.tabId === event.sourceTabId;
  }

  private async pauseAfterChild(
    ref: AutonomousTaskRef,
    childResult: AutonomousTaskChildRunResult,
  ): Promise<AutonomousTaskMutationResult> {
    if (childResult.status === 'terminal') {
      return { status: 'applied', snapshot: childResult.snapshot };
    }
    if (childResult.status === 'ignored') {
      return this.pauseIfNonterminal(ref);
    }
    return this.pauseIfNonterminal(ref);
  }

  private stopAfterChild(
    ref: AutonomousTaskRef,
    childResult: AutonomousTaskChildRunResult,
  ): AutonomousTaskMutationResult {
    if (childResult.status === 'terminal') {
      return { status: 'applied', snapshot: childResult.snapshot };
    }
    return this.cancelIfNonterminal(ref);
  }

  private cancelIfNonterminal(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status === 'terminal') {
      return { status: 'applied', snapshot: inspected.snapshot };
    }
    if (inspected.status === 'missing' || inspected.status === 'superseded') {
      return { status: 'ignored' };
    }
    return this.coordinator.cancelTask(ref);
  }

  private blockBudgetIfStillNonterminal(
    ref: AutonomousTaskRef,
    childResult: AutonomousTaskChildRunResult,
  ): void {
    if (childResult.status === 'terminal') {
      this.tabState.releaseTask(ref.taskId);
      return;
    }
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status === 'terminal') {
      this.tabState.releaseTask(ref.taskId);
      return;
    }
    if (inspected.status === 'missing' || inspected.status === 'superseded') {
      return;
    }
    const blocked = this.coordinator.markBlocked(ref, 'TASK_LIMIT_REACHED');
    if (isAutonomousTaskApplied(blocked)) {
      this.tabState.releaseTask(ref.taskId);
    }
  }

  private pauseIfNonterminal(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status === 'terminal' || inspected.status === 'missing' || inspected.status === 'superseded') {
      return inspected.status === 'terminal'
        ? { status: 'applied', snapshot: inspected.snapshot }
        : { status: 'ignored' };
    }
    if (inspected.status === 'paused' || inspected.snapshot.state === 'paused') {
      return { status: 'applied', snapshot: inspected.snapshot };
    }
    return this.coordinator.pauseAtSafeBoundary(ref);
  }

  private blockIfStillNonterminal(
    ref: AutonomousTaskRef,
    childResult: AutonomousTaskChildRunResult,
  ): void {
    if (childResult.status === 'terminal') {
      this.tabState.releaseTask(ref.taskId);
      return;
    }
    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status === 'terminal') {
      this.tabState.releaseTask(ref.taskId);
      return;
    }
    if (inspected.status === 'missing' || inspected.status === 'superseded') {
      return;
    }
    if (inspected.snapshot.state === 'paused') {
      return;
    }
    const blocked = this.coordinator.markBlocked(ref, 'TAB_UNAVAILABLE');
    if (isAutonomousTaskApplied(blocked)) {
      this.tabState.releaseTask(ref.taskId);
    }
  }

  releaseWorkspace(taskId: string): void {
    this.tabState.releaseTask(taskId);
  }
}
