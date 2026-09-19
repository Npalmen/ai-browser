import { ModelError } from '../ai/model-errors';
import type { BrowserTabCreatedEvent } from '../browser/tab-creation';
import {
  AutonomousTaskChildRunExecutor,
  type AutonomousTaskChildRunResult,
} from '../autonomous-task/autonomous-task-child-run-executor';
import { AutonomousTaskCoordinator } from '../autonomous-task/autonomous-task-coordinator';
import { AutonomousTaskError } from '../autonomous-task/autonomous-task-errors';
import type { AutonomousTaskPlannerResult } from '../autonomous-task/autonomous-task-planner';
import {
  MAX_AUTONOMOUS_TASK_PLANNER_PROGRESS_ENTRIES,
  type ModelSubgoalResult,
  type TrustedTaskProgressEntry,
} from '../autonomous-task/autonomous-task-planner-context';
import { AutonomousTaskPlannerExecutor } from '../autonomous-task/autonomous-task-planner-executor';
import {
  isActiveAutonomousTaskState,
  isAutonomousTaskApplied,
  isTerminalAutonomousTaskState,
  toAutonomousTaskRef,
  type AutonomousTaskMutationResult,
  type AutonomousTaskSnapshot,
  type AutonomousTaskState,
} from '../autonomous-task/autonomous-task-types';
import type { TabId } from '../shared/browser-types';
import {
  AUTONOMOUS_TASK_VIEW_LIMITS,
  MAX_AUTONOMOUS_TASK_ANSWER_CHARS,
  MAX_AUTONOMOUS_TASK_UI_QUESTION_CHARS,
  type AutonomousTaskControlResult,
  type AutonomousTaskEvent,
  type AutonomousTaskEventType,
  type AutonomousTaskStartResult,
  type AutonomousTaskView,
  type AutonomousTaskViewState,
  type AutonomousTaskViewTerminalReason,
} from '../shared/autonomous-task-types';
import { aiSafeError, toAiSafeError } from './ai-safe-error';
import { AutonomousTaskLifecycleController } from './autonomous-task-lifecycle-controller';

interface ProductAutonomousTask {
  taskId: string;
  objective: string;
  trustedProgress: TrustedTaskProgressEntry[];
  modelSubgoalResults: ModelSubgoalResult[];
  pendingUserClarification?: string;
  currentSubgoalTabAlias?: string;
  currentSubgoalOrdinal?: number;
  question?: string;
  finalAnswer?: string;
  loopGeneration: number;
}

export interface CompletedDelegationTurn {
  readonly taskId: string;
  readonly objective: string;
  readonly answer: string;
}

export interface AutonomousTaskControllerDependencies {
  coordinator: AutonomousTaskCoordinator;
  lifecycle: AutonomousTaskLifecycleController;
  planner: AutonomousTaskPlannerExecutor;
  childRuns: AutonomousTaskChildRunExecutor;
  emit: (event: AutonomousTaskEvent) => void;
}

/**
 * Product-level V6 orchestrator. Does not mint grants, approve V4 actions,
 * or call BrowserAdapter interaction primitives.
 */
export class AutonomousTaskController {
  private readonly coordinator: AutonomousTaskCoordinator;
  private readonly lifecycle: AutonomousTaskLifecycleController;
  private readonly planner: AutonomousTaskPlannerExecutor;
  private readonly childRuns: AutonomousTaskChildRunExecutor;
  private readonly emitEvent: (event: AutonomousTaskEvent) => void;
  private readonly products = new Map<string, ProductAutonomousTask>();
  private readonly completedTurns: CompletedDelegationTurn[] = [];
  private disposed = false;

  constructor(deps: AutonomousTaskControllerDependencies) {
    this.coordinator = deps.coordinator;
    this.lifecycle = deps.lifecycle;
    this.planner = deps.planner;
    this.childRuns = deps.childRuns;
    this.emitEvent = deps.emit;
  }

  start(objective: string): AutonomousTaskStartResult {
    if (this.disposed) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    try {
      const snapshot = this.lifecycle.startOnCurrentTab(objective);
      this.products.set(snapshot.taskId, {
        taskId: snapshot.taskId,
        objective: snapshot.objective,
        trustedProgress: [],
        modelSubgoalResults: [],
        loopGeneration: 1,
      });
      this.emitFromSnapshot(snapshot.taskId, 'autonomous-task-started');
      this.startPlanningLoop(snapshot.taskId, 1);
      const view = this.toView(snapshot);
      if (view === undefined) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return { ok: true, task: view };
    } catch (error) {
      return { ok: false, error: mapTaskError(error) };
    }
  }

  async pause(taskId: string): Promise<AutonomousTaskControlResult> {
    if (this.disposed) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    const snapshot = this.coordinator.getTask(taskId);
    if (snapshot === undefined) {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
    this.quiesceLoop(taskId);
    try {
      const result = await this.lifecycle.pause(toAutonomousTaskRef(snapshot));
      if (this.disposed) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return this.finishControl(taskId, result, 'autonomous-task-paused');
    } catch (error) {
      return { ok: false, error: mapTaskError(error) };
    }
  }

  resume(taskId: string): AutonomousTaskControlResult {
    if (this.disposed) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    const snapshot = this.coordinator.getTask(taskId);
    if (snapshot === undefined) {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
    if (snapshot.state !== 'paused') {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
    try {
      const result = this.lifecycle.resume(toAutonomousTaskRef(snapshot));
      if (!isAutonomousTaskApplied(result)) {
        return { ok: false, error: aiSafeError('INVALID_REQUEST'), ignored: true };
      }
      const product = this.ensureProduct(result.snapshot);
      product.loopGeneration += 1;
      this.emitFromSnapshot(taskId, 'autonomous-task-resumed');
      this.startPlanningLoop(taskId, product.loopGeneration);
      const view = this.toView(result.snapshot);
      if (view === undefined) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return { ok: true, task: view };
    } catch (error) {
      return { ok: false, error: mapTaskError(error) };
    }
  }

  async stop(taskId: string): Promise<AutonomousTaskControlResult> {
    if (this.disposed) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    const snapshot = this.coordinator.getTask(taskId);
    if (snapshot === undefined) {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
    this.quiesceLoop(taskId);
    try {
      const result = await this.lifecycle.stop(toAutonomousTaskRef(snapshot));
      if (this.disposed) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return this.finishControl(taskId, result);
    } catch (error) {
      return { ok: false, error: mapTaskError(error) };
    }
  }

  reply(taskId: string, reply: string): AutonomousTaskControlResult {
    if (this.disposed) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    const snapshot = this.coordinator.getTask(taskId);
    if (snapshot === undefined) {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
    if (snapshot.state === 'awaiting-approval') {
      return { ok: false, error: aiSafeError('INVALID_REQUEST'), ignored: true };
    }
    if (snapshot.state !== 'awaiting-user-input') {
      return { ok: false, error: aiSafeError('INVALID_REQUEST') };
    }
    const ref = toAutonomousTaskRef(snapshot);
    try {
      const result = this.coordinator.resumeFromUserInput(ref);
      if (!isAutonomousTaskApplied(result)) {
        return { ok: false, error: aiSafeError('INVALID_REQUEST'), ignored: true };
      }
      const product = this.ensureProduct(result.snapshot);
      product.pendingUserClarification = reply;
      product.question = undefined;
      product.loopGeneration += 1;
      this.emitFromSnapshot(taskId, 'autonomous-task-progress');
      this.startPlanningLoop(taskId, product.loopGeneration);
      const view = this.toView(result.snapshot);
      if (view === undefined) {
        return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
      }
      return { ok: true, task: view };
    } catch (error) {
      return { ok: false, error: mapTaskError(error) };
    }
  }

  getState(): AutonomousTaskView[] {
    if (this.disposed) {
      return [];
    }
    const views: AutonomousTaskView[] = [];
    for (const taskId of this.products.keys()) {
      const snapshot = this.coordinator.getTask(taskId);
      if (snapshot === undefined) {
        continue;
      }
      const view = this.toView(snapshot);
      if (view !== undefined) {
        views.push(view);
      }
    }
    return views;
  }

  getCompletedDelegationTurns(): readonly CompletedDelegationTurn[] {
    return this.completedTurns.slice();
  }

  handleTaskChanged(taskId: string): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.coordinator.getTask(taskId);
    if (snapshot === undefined) {
      return;
    }
    this.emitFromSnapshot(taskId, eventTypeForState(snapshot.state));
  }

  async handleTabCreated(event: BrowserTabCreatedEvent): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.lifecycle.handleTabCreated(event);
    if (this.disposed) {
      return;
    }
    const owner = this.coordinator.getTabOwner(event.tabId);
    if (owner !== undefined) {
      this.emitFromSnapshot(owner.taskId, eventTypeForCurrent(this.coordinator.getTask(owner.taskId)));
    }
  }

  async handleTabClosed(tabId: TabId): Promise<void> {
    if (this.disposed) {
      return;
    }
    const owner = this.coordinator.getTabOwner(tabId);
    const taskId = owner?.taskId;
    if (taskId !== undefined && this.shouldQuiesceForTabClose(tabId, taskId)) {
      this.quiesceLoop(taskId);
    }
    await this.lifecycle.handleTabClosed(tabId);
    if (this.disposed || taskId === undefined) {
      return;
    }
    this.emitFromSnapshot(taskId, eventTypeForCurrent(this.coordinator.getTask(taskId)));
  }

  handleGenericNavigation(tabId: TabId): void {
    if (this.disposed) {
      return;
    }
    this.lifecycle.handleGenericNavigation(tabId);
  }

  async beforeTrustedChromeNavigation(tabId: TabId): Promise<void> {
    if (this.disposed) {
      return;
    }
    const owner = this.coordinator.getTabOwner(tabId);
    if (owner !== undefined) {
      const task = this.coordinator.getTask(owner.taskId);
      if (task !== undefined && isActiveAutonomousTaskState(task.state)) {
        this.quiesceLoop(owner.taskId);
      }
    }
    await this.lifecycle.beforeTrustedChromeNavigation(tabId);
    if (this.disposed || owner === undefined) {
      return;
    }
    this.emitFromSnapshot(owner.taskId, eventTypeForCurrent(this.coordinator.getTask(owner.taskId)));
  }

  async handleRendererCrash(tabId: TabId): Promise<void> {
    await this.handleTabClosed(tabId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const product of this.products.values()) {
      product.loopGeneration += 1;
      const snapshot = this.coordinator.getTask(product.taskId);
      if (snapshot !== undefined) {
        this.planner.cancel(toAutonomousTaskRef(snapshot));
      }
    }
    this.products.clear();
    this.completedTurns.length = 0;
  }

  private quiesceLoop(taskId: string): number | undefined {
    const product = this.products.get(taskId);
    if (product === undefined) {
      return undefined;
    }
    product.loopGeneration += 1;
    return product.loopGeneration;
  }

  private shouldQuiesceForTabClose(tabId: TabId, taskId: string): boolean {
    const task = this.coordinator.getTask(taskId);
    if (task === undefined || !isActiveAutonomousTaskState(task.state)) {
      return false;
    }
    const child = this.childRuns.getActiveChild(taskId);
    if (child !== undefined && child.tabId === tabId) {
      return true;
    }
    return task.ownedTabCount <= 1;
  }

  private startPlanningLoop(taskId: string, loopGeneration: number): void {
    void this.runPlanningLoop(taskId, loopGeneration).catch(() => {
      // Loop failures are mapped to task terminal states inside runPlanningLoop.
    });
  }

  private async runPlanningLoop(taskId: string, loopGeneration: number): Promise<void> {
    while (!this.disposed && this.isCurrentLoop(taskId, loopGeneration)) {
      const snapshot = this.coordinator.getTask(taskId);
      if (snapshot === undefined || snapshot.state !== 'planning') {
        return;
      }
      const product = this.products.get(taskId);
      if (product === undefined) {
        return;
      }
      const ref = toAutonomousTaskRef(snapshot);
      let plannerResult: AutonomousTaskPlannerResult;
      try {
        plannerResult = await this.planner.plan(ref, {
          trustedProgress: product.trustedProgress,
          modelSubgoalResults: product.modelSubgoalResults,
          userClarification: product.pendingUserClarification,
        });
      } catch (error) {
        this.handlePlannerFailure(taskId, loopGeneration, ref.generation, error);
        return;
      }
      if (!this.isCurrentLoop(taskId, loopGeneration)) {
        return;
      }
      const inspected = this.coordinator.inspectTask(ref);
      if (inspected.status !== 'current' || inspected.snapshot.state !== 'planning') {
        return;
      }
      if (plannerResult.status !== 'decision') {
        return;
      }

      product.pendingUserClarification = undefined;
      const decision = plannerResult.decision;

      if (decision.kind === 'delegate-subgoal') {
        product.currentSubgoalTabAlias = decision.taskTabAlias;
        product.currentSubgoalOrdinal = inspected.snapshot.childRunCount + 1;
        this.emitFromSnapshot(taskId, 'autonomous-task-progress');
        const childResult = await this.childRuns.execute({
          ref,
          taskTabAlias: decision.taskTabAlias,
          instruction: decision.instruction,
        });
        if (!this.isCurrentLoop(taskId, loopGeneration)) {
          return;
        }
        this.applyChildResult(taskId, product, decision.taskTabAlias, childResult);
        if (childResult.status !== 'completed') {
          return;
        }
        continue;
      }

      if (decision.kind === 'request-user-input') {
        const marked = this.coordinator.markAwaitingUserInput(ref);
        if (!isAutonomousTaskApplied(marked)) {
          return;
        }
        product.question = clip(decision.question, MAX_AUTONOMOUS_TASK_UI_QUESTION_CHARS);
        this.emitFromSnapshot(taskId, 'autonomous-task-awaiting-user-input');
        return;
      }

      const completed = this.coordinator.markCompleted(ref);
      if (!isAutonomousTaskApplied(completed)) {
        return;
      }
      const answer = clip(decision.answer, MAX_AUTONOMOUS_TASK_ANSWER_CHARS);
      product.finalAnswer = answer;
      this.completedTurns.push({
        taskId,
        objective: product.objective,
        answer,
      });
      this.emitFromSnapshot(taskId, 'autonomous-task-completed');
      return;
    }
  }

  private applyChildResult(
    taskId: string,
    product: ProductAutonomousTask,
    taskTabAlias: string,
    childResult: AutonomousTaskChildRunResult,
  ): void {
    if (childResult.status === 'completed') {
      appendBounded(product.modelSubgoalResults, childResult.result, MAX_AUTONOMOUS_TASK_PLANNER_PROGRESS_ENTRIES);
      appendBounded(
        product.trustedProgress,
        { kind: 'child-run-completed', taskTabAlias },
        MAX_AUTONOMOUS_TASK_PLANNER_PROGRESS_ENTRIES,
      );
      product.currentSubgoalTabAlias = undefined;
      product.currentSubgoalOrdinal = undefined;
      this.emitFromSnapshot(taskId, 'autonomous-task-progress');
      return;
    }
    if (childResult.status === 'terminal') {
      this.emitFromSnapshot(taskId, eventTypeForState(childResult.snapshot.state));
    }
  }

  private handlePlannerFailure(
    taskId: string,
    loopGeneration: number,
    generation: number,
    error: unknown,
  ): void {
    if (!this.isCurrentLoop(taskId, loopGeneration)) {
      return;
    }
    const snapshot = this.coordinator.getTask(taskId);
    if (snapshot === undefined) {
      return;
    }
    if (isTerminalAutonomousTaskState(snapshot.state)) {
      this.emitFromSnapshot(taskId, eventTypeForState(snapshot.state));
      return;
    }
    if (isCancelledPlannerError(error)) {
      return;
    }
    if (snapshot.state !== 'planning' || snapshot.generation !== generation) {
      return;
    }
    if (!(error instanceof ModelError)) {
      const failed = this.coordinator.markFailed(toAutonomousTaskRef(snapshot), 'TASK_INTERNAL_ERROR');
      if (isAutonomousTaskApplied(failed)) {
        this.emitFromSnapshot(taskId, 'autonomous-task-failed');
      }
      return;
    }
    const failed = this.coordinator.markFailed(toAutonomousTaskRef(snapshot), 'PLANNER_FAILED');
    if (isAutonomousTaskApplied(failed)) {
      this.emitFromSnapshot(taskId, 'autonomous-task-failed');
    }
  }

  private finishControl(
    taskId: string,
    result: AutonomousTaskMutationResult,
    pausedType: AutonomousTaskEventType = 'autonomous-task-paused',
  ): AutonomousTaskControlResult {
    const snapshot =
      isAutonomousTaskApplied(result) ? result.snapshot : this.coordinator.getTask(taskId);
    if (snapshot === undefined) {
      return { ok: false, error: aiSafeError('INVALID_REQUEST'), ignored: true };
    }
    const type =
      snapshot.state === 'paused' ? pausedType : eventTypeForState(snapshot.state);
    this.emitFromSnapshot(taskId, type);
    const view = this.toView(snapshot);
    if (view === undefined) {
      return { ok: false, error: aiSafeError('AI_REQUEST_FAILED') };
    }
    return { ok: true, task: view };
  }

  private emitFromSnapshot(taskId: string, type: AutonomousTaskEventType): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.coordinator.getTask(taskId);
    if (snapshot === undefined) {
      return;
    }
    const view = this.toView(snapshot);
    if (view === undefined) {
      return;
    }
    this.emitSafely({ type, task: view });
  }

  private emitSafely(event: AutonomousTaskEvent): void {
    if (this.disposed) {
      return;
    }
    try {
      this.emitEvent(event);
    } catch {
      // Renderer emission is observational.
    }
  }

  private toView(snapshot: AutonomousTaskSnapshot): AutonomousTaskView | undefined {
    const product = this.products.get(snapshot.taskId);
    const ownedTabs = this.coordinator.getOwnedTabs(snapshot.taskId);
    const child = this.childRuns.getActiveChild(snapshot.taskId);
    const attention = attentionFor(snapshot.state);
    const view: AutonomousTaskView = {
      taskId: snapshot.taskId,
      state: snapshot.state as AutonomousTaskViewState,
      plannerStepCount: snapshot.plannerStepCount,
      childRunCount: snapshot.childRunCount,
      ownedTabCount: snapshot.ownedTabCount,
      taskApprovalCount: snapshot.taskApprovalCount,
      limits: AUTONOMOUS_TASK_VIEW_LIMITS,
      ownedTabIds: ownedTabs.map((tab) => tab.tabId),
      ...(product?.currentSubgoalTabAlias !== undefined && product.currentSubgoalOrdinal !== undefined
        ? {
            currentSubgoal: {
              tabAlias: product.currentSubgoalTabAlias,
              ordinal: product.currentSubgoalOrdinal,
            },
          }
        : {}),
      ...(attention !== undefined ? { attention } : {}),
      ...(attention === 'approval' && child !== undefined ? { attentionTabId: child.tabId } : {}),
      ...(snapshot.terminalReason !== undefined
        ? { terminalReason: snapshot.terminalReason as AutonomousTaskViewTerminalReason }
        : {}),
      ...(snapshot.state === 'awaiting-user-input' && product?.question !== undefined
        ? { question: product.question }
        : {}),
      ...(snapshot.state === 'completed' && product?.finalAnswer !== undefined
        ? { completedAnswer: product.finalAnswer }
        : {}),
    };
    return Object.freeze(view);
  }

  private ensureProduct(snapshot: AutonomousTaskSnapshot): ProductAutonomousTask {
    const existing = this.products.get(snapshot.taskId);
    if (existing !== undefined) {
      return existing;
    }
    const created: ProductAutonomousTask = {
      taskId: snapshot.taskId,
      objective: snapshot.objective,
      trustedProgress: [],
      modelSubgoalResults: [],
      loopGeneration: 0,
    };
    this.products.set(snapshot.taskId, created);
    return created;
  }

  private isCurrentLoop(taskId: string, loopGeneration: number): boolean {
    if (this.disposed) {
      return false;
    }
    return this.products.get(taskId)?.loopGeneration === loopGeneration;
  }
}

function attentionFor(state: AutonomousTaskState): 'approval' | 'user-input' | undefined {
  if (state === 'awaiting-approval') {
    return 'approval';
  }
  if (state === 'awaiting-user-input') {
    return 'user-input';
  }
  return undefined;
}

function eventTypeForCurrent(snapshot: AutonomousTaskSnapshot | undefined): AutonomousTaskEventType {
  if (snapshot === undefined) {
    return 'autonomous-task-progress';
  }
  return eventTypeForState(snapshot.state);
}

function eventTypeForState(state: AutonomousTaskState): AutonomousTaskEventType {
  switch (state) {
    case 'awaiting-approval':
      return 'autonomous-task-awaiting-approval';
    case 'awaiting-user-input':
      return 'autonomous-task-awaiting-user-input';
    case 'paused':
      return 'autonomous-task-paused';
    case 'completed':
      return 'autonomous-task-completed';
    case 'blocked':
      return 'autonomous-task-blocked';
    case 'failed':
      return 'autonomous-task-failed';
    case 'cancelled':
      return 'autonomous-task-cancelled';
    case 'execution-state-unknown':
      return 'autonomous-task-execution-state-unknown';
    default:
      return 'autonomous-task-progress';
  }
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

function appendBounded<T>(items: T[], entry: T, max: number): void {
  items.push(entry);
  if (items.length > max) {
    items.splice(0, items.length - max);
  }
}

function isCancelledPlannerError(error: unknown): boolean {
  return error instanceof ModelError && error.code === 'REQUEST_CANCELLED';
}

function mapTaskError(error: unknown): ReturnType<typeof aiSafeError> {
  if (error instanceof AutonomousTaskError) {
    if (error.code === 'INVALID_TAB_ID' || error.code === 'TASK_TAB_NOT_OWNED') {
      return aiSafeError('TAB_NOT_FOUND');
    }
    return aiSafeError('INVALID_REQUEST');
  }
  return toAiSafeError(error);
}
