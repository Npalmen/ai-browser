import { randomUUID } from 'node:crypto';

import type { TabId } from '../shared/browser-types';
import {
  buildAutonomousTaskAuditEvent,
  type AutonomousTaskAuditEventType,
  type AutonomousTaskAuditSink,
} from './autonomous-task-audit';
import { AutonomousTaskError } from './autonomous-task-errors';
import {
  isActiveAutonomousTaskState,
  isTerminalAutonomousTaskState,
  MAX_AUTONOMOUS_TASK_APPROVALS,
  MAX_AUTONOMOUS_TASK_CHILD_RUNS,
  MAX_AUTONOMOUS_TASK_OWNED_TABS,
  MAX_AUTONOMOUS_TASK_PLANNER_STEPS,
  toAutonomousTaskRef,
  type AutonomousTaskBlockedReason,
  type AutonomousTaskCancelledReason,
  type AutonomousTaskFailedReason,
  type AutonomousTaskId,
  type AutonomousTaskMutationResult,
  type AutonomousTaskRef,
  type AutonomousTaskRefStatus,
  type AutonomousTaskSnapshot,
  type AutonomousTaskState,
  type AutonomousTaskTerminalReason,
} from './autonomous-task-types';
import { TaskTabRegistry, type TaskTabOwnershipKind, type TaskTabSnapshot } from './task-tab-registry';

export interface AutonomousTaskCoordinatorDependencies {
  now?: () => number;
  generateTaskId?: () => string;
  auditSink?: AutonomousTaskAuditSink;
  tabRegistry?: TaskTabRegistry;
}

interface InternalAutonomousTask {
  taskId: AutonomousTaskId;
  generation: number;
  objective: string;
  startedAt: number;
  startingTabId: TabId;
  state: AutonomousTaskState;
  plannerStepCount: number;
  childRunCount: number;
  ownedTabCount: number;
  taskApprovalCount: number;
  terminalReason?: AutonomousTaskTerminalReason;
  lastCompletedSubgoalFingerprint?: string;
}

export class AutonomousTaskCoordinator {
  private readonly now: () => number;
  private readonly generateTaskId: () => string;
  private readonly auditSink: AutonomousTaskAuditSink | undefined;
  private readonly tabRegistry: TaskTabRegistry;

  private readonly byTaskId = new Map<AutonomousTaskId, InternalAutonomousTask>();
  private activeTaskId: AutonomousTaskId | undefined;
  private disposed = false;

  constructor(deps: AutonomousTaskCoordinatorDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.generateTaskId = deps.generateTaskId ?? randomUUID;
    this.auditSink = deps.auditSink;
    this.tabRegistry = deps.tabRegistry ?? new TaskTabRegistry();
  }

  startTask(startingTabId: TabId, objective: string): AutonomousTaskSnapshot {
    this.assertNotDisposed();
    const validatedTabId = requireTabId(startingTabId);
    const validatedObjective = requireObjective(objective);
    const startedAt = this.now();
    const taskId = requireGeneratedTaskId(this.generateTaskId());
    this.assertTaskIdAvailable(taskId);
    this.assertNoActiveTask();
    this.assertTabUnowned(validatedTabId);

    const record: InternalAutonomousTask = {
      taskId,
      generation: 1,
      objective: validatedObjective,
      startedAt,
      startingTabId: validatedTabId,
      state: 'planning',
      plannerStepCount: 0,
      childRunCount: 0,
      ownedTabCount: 0,
      taskApprovalCount: 0,
    };

    this.byTaskId.set(taskId, record);
    this.activeTaskId = taskId;
    try {
      this.tabRegistry.adoptStartingTab(taskId, validatedTabId);
    } catch (error) {
      this.byTaskId.delete(taskId);
      this.activeTaskId = undefined;
      throw error;
    }
    record.ownedTabCount = this.tabRegistry.countOwnedTabs(taskId);
    this.audit('task-started', record);
    this.audit('task-tab-added', record);
    return toSnapshot(record);
  }

  getTask(taskId: AutonomousTaskId): AutonomousTaskSnapshot | undefined {
    const record = this.byTaskId.get(taskId);
    return record ? toSnapshot(record) : undefined;
  }

  getActiveTask(): AutonomousTaskSnapshot | undefined {
    if (this.activeTaskId === undefined) {
      return undefined;
    }
    const record = this.byTaskId.get(this.activeTaskId);
    return record ? toSnapshot(record) : undefined;
  }

  isCurrentTask(ref: AutonomousTaskRef): boolean {
    return this.inspectTask(ref).status === 'current';
  }

  inspectTask(ref: AutonomousTaskRef): AutonomousTaskRefStatus {
    const record = this.byTaskId.get(ref.taskId);
    if (record === undefined) {
      return { status: 'missing' };
    }
    const snapshot = toSnapshot(record);
    if (record.generation !== ref.generation) {
      return { status: 'superseded', snapshot };
    }
    if (isTerminalAutonomousTaskState(record.state)) {
      return { status: 'terminal', snapshot };
    }
    if (record.state === 'paused') {
      return { status: 'paused', snapshot };
    }
    return { status: 'current', snapshot };
  }

  assertCanStartPlannerStep(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'planning');
    if (record.plannerStepCount >= MAX_AUTONOMOUS_TASK_PLANNER_STEPS) {
      return this.blockForBudget(record);
    }
    return applied(record);
  }

  recordPlannerStepCompleted(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'planning');
    if (record.plannerStepCount >= MAX_AUTONOMOUS_TASK_PLANNER_STEPS) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        'Planner-step budget is already exhausted.',
      );
    }
    record.plannerStepCount += 1;
    this.audit('planner-step-completed', record);
    return applied(record);
  }

  assertCanStartChildRun(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'planning');
    if (record.childRunCount >= MAX_AUTONOMOUS_TASK_CHILD_RUNS) {
      return this.blockForBudget(record);
    }
    return applied(record);
  }

  beginChildRun(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'planning');
    if (record.childRunCount >= MAX_AUTONOMOUS_TASK_CHILD_RUNS) {
      return this.blockForBudget(record);
    }
    record.childRunCount += 1;
    record.state = 'running-subgoal';
    this.audit('state-transition', record);
    this.audit('child-run-started', record);
    return applied(record);
  }

  markChildCompleted(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'running-subgoal');
    this.assertAllowedTransition(record, 'planning');
    record.state = 'planning';
    this.audit('state-transition', record);
    this.audit('child-run-completed', record);
    return applied(record);
  }

  assertApprovalBudgetAvailable(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    if (record.state !== 'planning' && record.state !== 'running-subgoal') {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} cannot check approval budget from ${record.state}.`,
      );
    }
    if (record.taskApprovalCount >= MAX_AUTONOMOUS_TASK_APPROVALS) {
      return this.blockForBudget(record);
    }
    return applied(record);
  }

  recordApprovalPresented(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'running-subgoal');
    if (record.taskApprovalCount >= MAX_AUTONOMOUS_TASK_APPROVALS) {
      return this.blockForBudget(record);
    }
    record.taskApprovalCount += 1;
    record.state = 'awaiting-approval';
    this.audit('state-transition', record);
    this.audit('approval-presented', record);
    return applied(record);
  }

  markApprovalExecuted(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'awaiting-approval');
    this.assertAllowedTransition(record, 'running-subgoal');
    record.state = 'running-subgoal';
    this.audit('state-transition', record);
    return applied(record);
  }

  markAwaitingUserInput(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertAllowedTransition(record, 'awaiting-user-input');
    record.state = 'awaiting-user-input';
    this.audit('state-transition', record);
    this.audit('awaiting-user-input', record);
    return applied(record);
  }

  pauseAtSafeBoundary(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMatchingGeneration(ref);
    if (record === undefined) {
      return ignored();
    }
    if (isTerminalAutonomousTaskState(record.state)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} is terminal and cannot pause.`,
      );
    }
    if (record.state === 'paused') {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} is already paused.`,
      );
    }
    this.assertAllowedTransition(record, 'paused');
    record.state = 'paused';
    this.clearActiveSlot(record);
    this.audit('state-transition', record);
    this.audit('task-paused', record);
    return applied(record);
  }

  resumeTask(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMatchingGeneration(ref);
    if (record === undefined) {
      return ignored();
    }
    if (record.state !== 'paused') {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} must be paused to resume, found ${record.state}.`,
      );
    }
    this.assertNoActiveTask();
    this.beginFreshPlanningEpoch(record);
    this.activeTaskId = record.taskId;
    this.audit('state-transition', record);
    this.audit('task-resumed', record);
    return applied(record);
  }

  resumeFromUserInput(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'awaiting-user-input');
    this.beginFreshPlanningEpoch(record);
    this.audit('state-transition', record);
    this.audit('task-resumed', record);
    return applied(record);
  }

  markCompleted(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    return this.terminalize(ref, 'completed', 'COMPLETED');
  }

  markBlocked(ref: AutonomousTaskRef, reason: AutonomousTaskBlockedReason): AutonomousTaskMutationResult {
    return this.terminalize(ref, 'blocked', reason);
  }

  markFailed(ref: AutonomousTaskRef, reason: AutonomousTaskFailedReason): AutonomousTaskMutationResult {
    return this.terminalize(ref, 'failed', reason);
  }

  markExecutionStateUnknown(ref: AutonomousTaskRef): AutonomousTaskMutationResult {
    return this.terminalize(ref, 'execution-state-unknown', 'EXECUTION_STATE_UNKNOWN');
  }

  cancelTask(
    ref: AutonomousTaskRef,
    reason: AutonomousTaskCancelledReason = 'USER_CANCELLED',
  ): AutonomousTaskMutationResult {
    return this.terminalize(ref, 'cancelled', reason);
  }

  adoptTaskTab(
    ref: AutonomousTaskRef,
    tabId: TabId,
    ownershipKind: TaskTabOwnershipKind,
  ): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    const validatedTabId = requireTabId(tabId);
    const owner = this.tabRegistry.getOwner(validatedTabId);
    if (owner !== undefined && owner.taskId === record.taskId) {
      return applied(record);
    }
    if (owner !== undefined) {
      throw new AutonomousTaskError(
        'TASK_TAB_ALREADY_OWNED',
        `Tab ${validatedTabId} already belongs to another task.`,
      );
    }
    if (record.ownedTabCount >= MAX_AUTONOMOUS_TASK_OWNED_TABS) {
      return this.blockForBudget(record);
    }
    this.tabRegistry.adoptTab(record.taskId, validatedTabId, ownershipKind);
    record.ownedTabCount = this.tabRegistry.countOwnedTabs(record.taskId);
    this.audit('task-tab-added', record);
    return applied(record);
  }

  releaseTaskTab(ref: AutonomousTaskRef, alias: string): AutonomousTaskMutationResult {
    const record = this.resolveMatchingGeneration(ref);
    if (record === undefined) {
      return ignored();
    }
    if (isTerminalAutonomousTaskState(record.state)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} is terminal and cannot release tabs.`,
      );
    }
    this.tabRegistry.releaseTab(record.taskId, alias);
    record.ownedTabCount = this.tabRegistry.countOwnedTabs(record.taskId);
    this.audit('task-tab-removed', record);
    return applied(record);
  }

  getOwnedTabs(taskId: AutonomousTaskId): ReadonlyArray<TaskTabSnapshot> {
    return this.tabRegistry.getOwnedTabs(taskId);
  }

  resolveTaskTabAlias(taskId: AutonomousTaskId, alias: string): TaskTabSnapshot | undefined {
    return this.tabRegistry.resolveAlias(taskId, alias);
  }

  assertNoImmediateRepeatedSubgoal(
    ref: AutonomousTaskRef,
    fingerprint: string,
  ): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'planning');
    requireFingerprint(fingerprint);
    if (record.lastCompletedSubgoalFingerprint === fingerprint) {
      return this.transitionRecord(record, 'blocked', 'TASK_NO_PROGRESS');
    }
    return applied(record);
  }

  recordCompletedSubgoalFingerprint(
    ref: AutonomousTaskRef,
    fingerprint: string,
  ): AutonomousTaskMutationResult {
    const record = this.resolveMutableActive(ref);
    if (record === undefined) {
      return ignored();
    }
    this.assertState(record, 'running-subgoal');
    requireFingerprint(fingerprint);
    record.lastCompletedSubgoalFingerprint = fingerprint;
    return applied(record);
  }

  dispose(): void {
    const live = [...this.byTaskId.values()].filter(
      (record) => !isTerminalAutonomousTaskState(record.state),
    );
    for (const record of live) {
      record.state = 'cancelled';
      record.terminalReason = 'RUNTIME_DISPOSED';
      this.clearActiveSlot(record);
      this.tabRegistry.releaseTask(record.taskId);
      record.ownedTabCount = 0;
      this.audit('state-transition', record);
      this.audit('task-terminal', record);
    }
    this.byTaskId.clear();
    this.activeTaskId = undefined;
    this.tabRegistry.clear();
    this.disposed = true;
  }

  private terminalize(
    ref: AutonomousTaskRef,
    next: AutonomousTaskState,
    reason: AutonomousTaskTerminalReason,
  ): AutonomousTaskMutationResult {
    const record = this.resolveMatchingGeneration(ref);
    if (record === undefined) {
      return ignored();
    }
    if (isTerminalAutonomousTaskState(record.state)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} is terminal and cannot transition.`,
      );
    }
    return this.transitionRecord(record, next, reason);
  }

  private transitionRecord(
    record: InternalAutonomousTask,
    next: AutonomousTaskState,
    reason?: AutonomousTaskTerminalReason,
  ): AutonomousTaskMutationResult {
    this.assertAllowedTransition(record, next);
    record.state = next;
    if (isTerminalAutonomousTaskState(next)) {
      if (reason === undefined) {
        throw new AutonomousTaskError(
          'AUTONOMOUS_TASK_INVALID_TRANSITION',
          'Terminal AutonomousTask states require a reason.',
        );
      }
      record.terminalReason = reason;
      this.clearActiveSlot(record);
      this.tabRegistry.releaseTask(record.taskId);
      record.ownedTabCount = 0;
      this.audit('state-transition', record);
      this.audit('task-terminal', record);
      return applied(record);
    }
    this.audit('state-transition', record);
    return applied(record);
  }

  private blockForBudget(record: InternalAutonomousTask): AutonomousTaskMutationResult {
    return this.transitionRecord(record, 'blocked', 'TASK_LIMIT_REACHED');
  }

  private beginFreshPlanningEpoch(record: InternalAutonomousTask): void {
    record.generation += 1;
    record.state = 'planning';
    record.lastCompletedSubgoalFingerprint = undefined;
  }

  private resolveMutableActive(ref: AutonomousTaskRef): InternalAutonomousTask | undefined {
    const record = this.resolveMatchingGeneration(ref);
    if (record === undefined) {
      return undefined;
    }
    if (isTerminalAutonomousTaskState(record.state)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} is terminal and cannot transition.`,
      );
    }
    if (!isActiveAutonomousTaskState(record.state) || this.activeTaskId !== record.taskId) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} is not the active task.`,
      );
    }
    return record;
  }

  private resolveMatchingGeneration(ref: AutonomousTaskRef): InternalAutonomousTask | undefined {
    if (this.disposed) {
      return undefined;
    }
    const record = this.byTaskId.get(ref.taskId);
    if (record === undefined || record.generation !== ref.generation) {
      return undefined;
    }
    return record;
  }

  private assertAllowedTransition(record: InternalAutonomousTask, next: AutonomousTaskState): void {
    if (!isTransitionAllowed(record.state, next)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `Cannot transition AutonomousTask from ${record.state} to ${next}.`,
      );
    }
  }

  private assertState(record: InternalAutonomousTask, expected: AutonomousTaskState): void {
    if (record.state !== expected) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${record.taskId} must be ${expected}, found ${record.state}.`,
      );
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        'AutonomousTaskCoordinator has been disposed.',
      );
    }
  }

  private assertNoActiveTask(): void {
    if (this.activeTaskId === undefined) {
      return;
    }
    throw new AutonomousTaskError(
      'AUTONOMOUS_TASK_ALREADY_ACTIVE',
      `AutonomousTask ${this.activeTaskId} is already active.`,
    );
  }

  private assertTaskIdAvailable(taskId: AutonomousTaskId): void {
    if (this.byTaskId.has(taskId)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_ID_COLLISION',
        `taskId already exists: ${taskId}`,
      );
    }
  }

  private assertTabUnowned(tabId: TabId): void {
    const owner = this.tabRegistry.getOwner(tabId);
    if (owner !== undefined) {
      throw new AutonomousTaskError(
        'TASK_TAB_ALREADY_OWNED',
        `Tab ${tabId} already belongs to another task.`,
      );
    }
  }

  private clearActiveSlot(record: InternalAutonomousTask): void {
    if (this.activeTaskId === record.taskId) {
      this.activeTaskId = undefined;
    }
  }

  private audit(eventType: AutonomousTaskAuditEventType, record: InternalAutonomousTask): void {
    if (this.auditSink === undefined) {
      return;
    }
    try {
      this.auditSink.append(
        buildAutonomousTaskAuditEvent(eventType, toSnapshot(record), this.now()),
      );
    } catch {
      // Observational only. Lifecycle already committed.
    }
  }
}

function isTransitionAllowed(from: AutonomousTaskState, to: AutonomousTaskState): boolean {
  if (isTerminalAutonomousTaskState(from)) {
    return false;
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed.includes(to);
}

const ALLOWED_TRANSITIONS: Record<string, ReadonlyArray<AutonomousTaskState>> = {
  planning: [
    'running-subgoal',
    'awaiting-user-input',
    'paused',
    'completed',
    'cancelled',
    'blocked',
    'failed',
    'execution-state-unknown',
  ],
  'running-subgoal': [
    'planning',
    'awaiting-approval',
    'paused',
    'cancelled',
    'blocked',
    'failed',
    'execution-state-unknown',
  ],
  'awaiting-approval': [
    'running-subgoal',
    'paused',
    'cancelled',
    'blocked',
    'failed',
    'execution-state-unknown',
  ],
  'awaiting-user-input': ['planning', 'paused', 'cancelled', 'blocked', 'failed'],
  paused: ['planning', 'cancelled'],
};

function toSnapshot(record: InternalAutonomousTask): AutonomousTaskSnapshot {
  return Object.freeze({
    taskId: record.taskId,
    generation: record.generation,
    objective: record.objective,
    startedAt: record.startedAt,
    startingTabId: record.startingTabId,
    state: record.state,
    plannerStepCount: record.plannerStepCount,
    childRunCount: record.childRunCount,
    ownedTabCount: record.ownedTabCount,
    taskApprovalCount: record.taskApprovalCount,
    ...(record.terminalReason !== undefined ? { terminalReason: record.terminalReason } : {}),
    ...(record.lastCompletedSubgoalFingerprint !== undefined
      ? { lastCompletedSubgoalFingerprint: record.lastCompletedSubgoalFingerprint }
      : {}),
  });
}

function applied(record: InternalAutonomousTask): AutonomousTaskMutationResult {
  return { status: 'applied', snapshot: toSnapshot(record) };
}

function ignored(): AutonomousTaskMutationResult {
  return { status: 'ignored' };
}

function requireTabId(tabId: TabId): TabId {
  if (typeof tabId !== 'string' || tabId.trim().length === 0) {
    throw new AutonomousTaskError('INVALID_TAB_ID', 'tabId must be a non-empty string.');
  }
  return tabId;
}

function requireGeneratedTaskId(id: string): AutonomousTaskId {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new AutonomousTaskError(
      'INVALID_AUTONOMOUS_TASK_ID',
      'taskId must be a non-empty string.',
    );
  }
  return id;
}

function requireObjective(objective: string): string {
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    throw new AutonomousTaskError(
      'INVALID_AUTONOMOUS_TASK_OBJECTIVE',
      'objective must be a non-empty string.',
    );
  }
  return objective;
}

function requireFingerprint(fingerprint: string): void {
  if (typeof fingerprint !== 'string' || fingerprint.trim().length === 0) {
    throw new AutonomousTaskError(
      'INVALID_SUBGOAL_FINGERPRINT',
      'Subgoal fingerprint must be a non-empty string.',
    );
  }
}
