import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ModelError } from '../ai/model-errors';
import type { AgentRunRef } from '../agent-run/agent-run-types';
import type { TabId } from '../shared/browser-types';
import type { BrowserTabCreatedEvent } from '../browser/tab-creation';
import {
  AutonomousTaskChildRunExecutor,
  type AutonomousTaskChildRunRequest,
} from '../autonomous-task/autonomous-task-child-run-executor';
import type {
  AutonomousTaskAgentRunCompletion,
  AutonomousTaskAgentRunExecutionPort,
  AutonomousTaskAgentRunExecutionStartResult,
} from '../autonomous-task/agent-run-execution-port';
import { AutonomousTaskCoordinator } from '../autonomous-task/autonomous-task-coordinator';
import { AutonomousTaskError } from '../autonomous-task/autonomous-task-errors';
import { AutonomousTaskPlannerExecutor } from '../autonomous-task/autonomous-task-planner-executor';
import type { AutonomousTaskPlannerResult } from '../autonomous-task/autonomous-task-planner';
import { TaskTabStateRegistry } from '../autonomous-task/task-tab-state-registry';
import {
  toAutonomousTaskRef,
  type AutonomousTaskRef,
  type AutonomousTaskSnapshot,
} from '../autonomous-task/autonomous-task-types';
import { AutonomousTaskLifecycleController } from './autonomous-task-lifecycle-controller';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeBrowser {
  activeTabId: TabId = 'tab-a';
  extraTabIds: TabId[] = [];

  getBrowserState(): { activeTabId: TabId; tabs: { id: TabId }[] } {
    if (!this.activeTabId) {
      throw new Error('No active tab');
    }
    const ids = new Set<TabId>([this.activeTabId, ...this.extraTabIds]);
    return {
      activeTabId: this.activeTabId,
      tabs: [...ids].map((id) => ({ id })),
    };
  }
}

class FakeManual {
  readonly active = new Set<TabId>();

  isActive(tabId: TabId): boolean {
    return this.active.has(tabId);
  }
}

class FakeAgentRuns implements AutonomousTaskAgentRunExecutionPort {
  starts = 0;
  lastRef: AgentRunRef | undefined;
  hold: Deferred<AutonomousTaskAgentRunCompletion> | undefined;
  started = new Deferred<void>();
  cancelCalls: AgentRunRef[] = [];
  cancelAndWaitCalls: AgentRunRef[] = [];
  drainCompletion: 'cancelled' | 'completed' = 'cancelled';

  async start(
    tabId: TabId,
    instruction: string,
  ): Promise<AutonomousTaskAgentRunExecutionStartResult> {
    this.starts += 1;
    const ref: AgentRunRef = { runId: `run-${this.starts}`, tabId, generation: this.starts };
    this.lastRef = ref;
    this.hold = new Deferred();
    this.started.resolve();
    return {
      status: 'started',
      run: {
        runId: ref.runId,
        tabId,
        generation: ref.generation,
        instruction,
        startedAt: 1,
        state: 'running',
        modelStepCount: 0,
        actionAttemptCount: 0,
        approvalCount: 0,
      },
      ref,
      completion: this.hold.promise,
    };
  }

  cancel(ref: AgentRunRef): boolean {
    this.cancelCalls.push(ref);
    return true;
  }

  async cancelAndWait(ref: AgentRunRef): Promise<void> {
    this.cancelAndWaitCalls.push(ref);
    this.cancel(ref);
    if (this.drainCompletion === 'completed') {
      this.hold?.resolve({
        status: 'completed',
        run: {
          runId: ref.runId,
          tabId: ref.tabId,
          generation: ref.generation,
          instruction: 'child',
          startedAt: 1,
          state: 'completed',
          modelStepCount: 1,
          actionAttemptCount: 0,
          approvalCount: 0,
          terminalReason: 'COMPLETED',
        },
        answer: {
          text: 'late child text',
          referencedTargets: [],
          alias: 'page-standard',
          truncatedContext: false,
          documentRevision: 'rev-1',
        },
      });
    } else {
      this.hold?.resolve({
        status: 'terminal',
        run: {
          runId: ref.runId,
          tabId: ref.tabId,
          generation: ref.generation,
          instruction: 'child',
          startedAt: 1,
          state: 'cancelled',
          modelStepCount: 0,
          actionAttemptCount: 0,
          approvalCount: 0,
          terminalReason: 'USER_CANCELLED',
        },
      });
    }
    await this.hold?.promise;
  }
}

class HoldingPlanner {
  readonly hold = new Deferred<AutonomousTaskPlannerResult>();

  async plan(
    _ref: AutonomousTaskRef,
    _input: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<AutonomousTaskPlannerResult> {
    if (options.signal?.aborted) {
      throw new ModelError('REQUEST_CANCELLED', 'cancelled');
    }
    await new Promise<void>((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        reject(new ModelError('REQUEST_CANCELLED', 'cancelled'));
      });
      void this.hold.promise.then(() => resolve());
    });
    return { status: 'ignored' };
  }
}

function childRequest(snapshot: AutonomousTaskSnapshot): AutonomousTaskChildRunRequest {
  return {
    ref: toAutonomousTaskRef(snapshot),
    taskTabAlias: 'task-tab-1',
    instruction: 'Open the fare table',
  };
}

async function waitForChild(
  childRuns: AutonomousTaskChildRunExecutor,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (childRuns.getActiveChild(taskId) !== undefined) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('child did not become active');
}

function popupEvent(overrides: Partial<BrowserTabCreatedEvent> = {}): BrowserTabCreatedEvent {
  return {
    tabId: 'tab-c',
    cause: 'website-popup',
    sourceTabId: 'tab-a',
    causedByAgentInputDispatch: true,
    ...overrides,
  };
}

function createLifecycle(extras: { planner?: HoldingPlanner; agentRuns?: FakeAgentRuns } = {}) {
  const coordinator = new AutonomousTaskCoordinator({ generateTaskId: () => 'task-1' });
  const tabState = new TaskTabStateRegistry();
  const plannerImpl = extras.planner ?? new HoldingPlanner();
  const planner = new AutonomousTaskPlannerExecutor({ planner: plannerImpl });
  const agentRuns = extras.agentRuns ?? new FakeAgentRuns();
  const childRuns = new AutonomousTaskChildRunExecutor({ coordinator, agentRuns, tabState });
  const browser = new FakeBrowser();
  const manualRuns = new FakeManual();
  const lifecycle = new AutonomousTaskLifecycleController({
    coordinator,
    tabState,
    planner,
    childRuns,
    browser,
    manualRuns,
  });
  return { coordinator, tabState, planner, plannerImpl, childRuns, agentRuns, browser, manualRuns, lifecycle };
}

describe('AutonomousTaskLifecycleController', () => {
  it('starts on the trusted current tab and initializes generation 1', () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    assert.equal(task.startingTabId, 'tab-a');
    assert.equal(task.state, 'planning');
    assert.equal(harness.tabState.getToken(task.taskId, 'task-tab-1'), 'task-tab-state-v1:1');
    assert.equal(harness.coordinator.getTabOwner('tab-a')?.alias, 'task-tab-1');
  });

  it('fails closed when no trusted active tab exists', () => {
    const harness = createLifecycle();
    harness.browser.activeTabId = '';
    assert.throws(
      () => harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight'),
      (error: unknown) => error instanceof AutonomousTaskError && error.code === 'INVALID_TAB_ID',
    );
    assert.equal(harness.coordinator.getActiveTask(), undefined);
  });

  it('does not start while a manual Act is active on the current tab', () => {
    const harness = createLifecycle();
    harness.manualRuns.active.add('tab-a');
    assert.throws(
      () => harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight'),
      AutonomousTaskError,
    );
    assert.equal(harness.coordinator.getActiveTask(), undefined);
  });

  it('starts on a trusted inactive tab without changing the foreground tab', () => {
    const harness = createLifecycle();
    harness.browser.extraTabIds = ['tab-workflow'];
    const task = harness.lifecycle.startOnTrustedTab(
      'tab-workflow',
      'Book the cheapest refundable flight',
    );
    assert.equal(task.startingTabId, 'tab-workflow');
    assert.equal(harness.coordinator.getTabOwner('tab-workflow')?.alias, 'task-tab-1');
    assert.equal(harness.tabState.getToken(task.taskId, 'task-tab-1'), 'task-tab-state-v1:1');
    assert.equal(harness.browser.activeTabId, 'tab-a');
    assert.equal(harness.coordinator.getTabOwner('tab-a'), undefined);
  });

  it('rejects an unknown exact tab without starting a task', () => {
    const harness = createLifecycle();
    assert.throws(
      () => harness.lifecycle.startOnTrustedTab('tab-missing', 'Book the cheapest refundable flight'),
      (error: unknown) => error instanceof AutonomousTaskError && error.code === 'INVALID_TAB_ID',
    );
    assert.equal(harness.coordinator.getActiveTask(), undefined);
    assert.equal(harness.browser.activeTabId, 'tab-a');
  });

  it('rejects startOnTrustedTab while a manual Act is active on that exact tab', () => {
    const harness = createLifecycle();
    harness.browser.extraTabIds = ['tab-workflow'];
    harness.manualRuns.active.add('tab-workflow');
    assert.throws(
      () => harness.lifecycle.startOnTrustedTab('tab-workflow', 'Book the cheapest refundable flight'),
      AutonomousTaskError,
    );
    assert.equal(harness.coordinator.getActiveTask(), undefined);
    assert.equal(harness.browser.activeTabId, 'tab-a');
  });

  it('still blocks a second start while an AutonomousTask is active', () => {
    const harness = createLifecycle();
    harness.browser.extraTabIds = ['tab-workflow'];
    harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    assert.throws(
      () => harness.lifecycle.startOnTrustedTab('tab-workflow', 'Another task'),
      AutonomousTaskError,
    );
    assert.equal(harness.coordinator.getActiveTask()?.startingTabId, 'tab-a');
    assert.equal(harness.browser.activeTabId, 'tab-a');
  });

  it('pauses planning with an active planner and ignores the late result', async () => {
    const plannerImpl = new HoldingPlanner();
    const harness = createLifecycle({ planner: plannerImpl });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.planner.plan(toAutonomousTaskRef(task));
    const paused = await harness.lifecycle.pause(toAutonomousTaskRef(task));
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'paused');
    }
    assert.equal((await pending).status, 'ignored');
    plannerImpl.hold.resolve({ status: 'ignored' });
  });

  it('pauses planning immediately when no planner is active', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const paused = await harness.lifecycle.pause(toAutonomousTaskRef(task));
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'paused');
    }
  });

  it('pauses a running child via exact lifecycle cancellation without CHILD_RUN_FAILED', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    const paused = await harness.lifecycle.pause(toAutonomousTaskRef(task));
    const child = await pending;
    assert.equal(child.status, 'lifecycle-cancelled');
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'paused');
      assert.notEqual(paused.snapshot.terminalReason, 'CHILD_RUN_FAILED');
    }
    assert.equal(agentRuns.cancelCalls[0]?.runId, agentRuns.lastRef?.runId);
  });

  it('completes a child that finishes before pause, then pauses the planning task', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    agentRuns.hold?.resolve({
      status: 'completed',
      run: {
        runId: agentRuns.lastRef!.runId,
        tabId: 'tab-a',
        generation: agentRuns.lastRef!.generation,
        instruction: 'Open the fare table',
        startedAt: 1,
        state: 'completed',
        modelStepCount: 1,
        actionAttemptCount: 0,
        approvalCount: 0,
        terminalReason: 'COMPLETED',
      },
      answer: {
        text: 'done',
        referencedTargets: [],
        alias: 'page-standard',
        truncatedContext: false,
        documentRevision: 'rev-1',
      },
    });
    const child = await pending;
    assert.equal(child.status, 'completed');
    const paused = await harness.lifecycle.pause(toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!));
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'paused');
    }
  });

  it('keeps unknown child truth instead of pausing', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    agentRuns.hold?.resolve({
      status: 'terminal',
      run: {
        runId: agentRuns.lastRef!.runId,
        tabId: 'tab-a',
        generation: agentRuns.lastRef!.generation,
        instruction: 'Open the fare table',
        startedAt: 1,
        state: 'execution-state-unknown',
        modelStepCount: 1,
        actionAttemptCount: 1,
        approvalCount: 0,
        terminalReason: 'EXECUTION_STATE_UNKNOWN',
      },
    });
    await pending;
    const paused = await harness.lifecycle.pause(toAutonomousTaskRef(task));
    assert.equal(paused.status, 'ignored');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'execution-state-unknown');
  });

  it('pauses awaiting-user-input immediately', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    harness.coordinator.markAwaitingUserInput(toAutonomousTaskRef(task));
    const paused = await harness.lifecycle.pause(toAutonomousTaskRef(task));
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'paused');
    }
  });

  it('treats pause as idempotent while already paused', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.pause(toAutonomousTaskRef(task));
    const second = await harness.lifecycle.pause(toAutonomousTaskRef(task));
    assert.equal(second.status, 'applied');
    if (second.status === 'applied') {
      assert.equal(second.snapshot.state, 'paused');
    }
  });

  it('resumes a paused task into a fresh planning generation', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const paused = await harness.lifecycle.pause(toAutonomousTaskRef(task));
    const resumed = harness.lifecycle.resume(toAutonomousTaskRef(paused.status === 'applied' ? paused.snapshot : task));
    assert.equal(resumed.status, 'applied');
    if (resumed.status === 'applied') {
      assert.equal(resumed.snapshot.state, 'planning');
      assert.equal(resumed.snapshot.generation, 2);
    }
    assert.equal(harness.planner.hasActive(task.taskId), false);
    assert.equal(harness.childRuns.getActiveChild(task.taskId), undefined);
  });

  it('rejects Resume of a paused task with zero owned tabs', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.pause(toAutonomousTaskRef(task));
    await harness.lifecycle.handleTabClosed('tab-a');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'paused');
    assert.equal(harness.coordinator.getOwnedTabs(task.taskId).length, 0);
    assert.throws(
      () => harness.lifecycle.resume(toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!)),
      AutonomousTaskError,
    );
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'paused');
  });

  it('rejects Resume while a manual Act is active on an owned tab', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.pause(toAutonomousTaskRef(task));
    harness.manualRuns.active.add('tab-a');
    assert.throws(
      () => harness.lifecycle.resume(toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!)),
      AutonomousTaskError,
    );
    harness.manualRuns.active.delete('tab-a');
    const resumed = harness.lifecycle.resume(toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!));
    assert.equal(resumed.status, 'applied');
  });

  it('does not adopt explicit or uncorrelated popups', async () => {
    const harness = createLifecycle();
    harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.handleTabCreated({
      tabId: 'tab-user',
      cause: 'explicit',
      causedByAgentInputDispatch: false,
    });
    await harness.lifecycle.handleTabCreated(popupEvent({ causedByAgentInputDispatch: false }));
    await harness.lifecycle.handleTabCreated(popupEvent({ sourceTabId: 'tab-other' }));
    assert.equal(harness.coordinator.getOwnedTabs('task-1').length, 1);
  });

  it('does not adopt a causal popup without an active child or while paused', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.handleTabCreated(popupEvent());
    assert.equal(harness.coordinator.getTabOwner('tab-c'), undefined);
    await harness.lifecycle.pause(toAutonomousTaskRef(task));
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-d' }));
    assert.equal(harness.coordinator.getTabOwner('tab-d'), undefined);
  });

  it('adopts a causal popup from the exact active child source tab', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    await harness.lifecycle.handleTabCreated(popupEvent());
    const owned = harness.coordinator.getTabOwner('tab-c');
    assert.equal(owned?.alias, 'task-tab-2');
    assert.equal(owned?.ownershipKind, 'task-created');
    assert.equal(harness.tabState.getToken(task.taskId, 'task-tab-2'), 'task-tab-state-v1:1');
    assert.equal(harness.childRuns.getActiveChild(task.taskId)?.agentRunRef.runId, agentRuns.lastRef?.runId);
    agentRuns.hold?.resolve({
      status: 'terminal',
      run: {
        runId: agentRuns.lastRef!.runId,
        tabId: 'tab-a',
        generation: agentRuns.lastRef!.generation,
        instruction: 'Open the fare table',
        startedAt: 1,
        state: 'cancelled',
        modelStepCount: 0,
        actionAttemptCount: 0,
        approvalCount: 0,
        terminalReason: 'USER_CANCELLED',
      },
    });
    await harness.childRuns.cancelActiveChildForLifecycle(toAutonomousTaskRef(task), 'USER_CANCELLED');
    await pending;
  });

  it('does not adopt a causal popup from a different child tab', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    await harness.lifecycle.handleTabCreated(popupEvent({ sourceTabId: 'tab-other', tabId: 'tab-x' }));
    assert.equal(harness.coordinator.getTabOwner('tab-x'), undefined);
    agentRuns.hold?.resolve({
      status: 'terminal',
      run: {
        runId: agentRuns.lastRef!.runId,
        tabId: 'tab-a',
        generation: agentRuns.lastRef!.generation,
        instruction: 'x',
        startedAt: 1,
        state: 'cancelled',
        modelStepCount: 0,
        actionAttemptCount: 0,
        approvalCount: 0,
        terminalReason: 'USER_CANCELLED',
      },
    });
    await pending;
  });

  it('blocks the fourth task tab without closing the new browser tab', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    const childRef = agentRuns.lastRef;
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-2' }));
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-3' }));
    assert.equal(harness.coordinator.getOwnedTabs(task.taskId).length, 3);
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-4' }));
    const child = await pending;
    const current = harness.coordinator.getTask(task.taskId);
    assert.equal(current?.state, 'blocked');
    assert.equal(current?.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(current?.generation, 1);
    assert.equal(current?.lastCompletedSubgoalFingerprint, undefined);
    assert.equal(harness.coordinator.getTabOwner('tab-4'), undefined);
    assert.equal(harness.coordinator.getOwnedTabs(task.taskId).length, 0);
    assert.equal(agentRuns.cancelAndWaitCalls.length, 1);
    assert.equal(agentRuns.cancelAndWaitCalls[0]?.runId, childRef?.runId);
    assert.equal(harness.childRuns.getActiveChild(task.taskId), undefined);
    assert.equal(child.status, 'ignored');
  });

  it('does not let a late child completion resurrect a tab-budget terminal task', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.drainCompletion = 'completed';
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-2' }));
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-3' }));
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-4' }));
    const child = await pending;
    const current = harness.coordinator.getTask(task.taskId);
    assert.equal(child.status, 'ignored');
    assert.equal(current?.state, 'blocked');
    assert.equal(current?.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(current?.generation, 1);
    assert.equal(current?.lastCompletedSubgoalFingerprint, undefined);
    assert.equal(harness.coordinator.getOwnedTabs(task.taskId).length, 0);
    assert.equal(harness.coordinator.getTabOwner('tab-a'), undefined);
  });

  it('keeps aliases monotonic after a released tab', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-2' }));
    await harness.lifecycle.handleTabClosed('tab-2');
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-3' }));
    assert.equal(harness.coordinator.getTabOwner('tab-3')?.alias, 'task-tab-3');
    agentRuns.hold?.resolve({
      status: 'terminal',
      run: {
        runId: agentRuns.lastRef!.runId,
        tabId: 'tab-a',
        generation: agentRuns.lastRef!.generation,
        instruction: 'x',
        startedAt: 1,
        state: 'cancelled',
        modelStepCount: 0,
        actionAttemptCount: 0,
        approvalCount: 0,
        terminalReason: 'USER_CANCELLED',
      },
    });
    await pending;
  });

  it('does not pause on generic navigation and only bumps tab state', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    harness.lifecycle.handleGenericNavigation('tab-a');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'planning');
    assert.equal(harness.tabState.getToken(task.taskId, 'task-tab-1'), 'task-tab-state-v1:2');
  });

  it('pauses an active owned tab before trusted chrome navigation', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.beforeTrustedChromeNavigation('tab-a');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'paused');
  });

  it('leaves a paused owned tab paused across trusted and generic navigation', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.pause(toAutonomousTaskRef(task));
    await harness.lifecycle.beforeTrustedChromeNavigation('tab-a');
    harness.lifecycle.handleGenericNavigation('tab-a');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'paused');
    assert.equal(harness.tabState.getToken(task.taskId, 'task-tab-1'), 'task-tab-state-v1:2');
  });

  it('does not affect a task when an unowned tab is navigated or closed', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.beforeTrustedChromeNavigation('tab-other');
    await harness.lifecycle.handleTabClosed('tab-other');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'planning');
    assert.equal(harness.coordinator.getOwnedTabs(task.taskId).length, 1);
  });

  it('blocks the task when the active child execution tab closes', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    await harness.lifecycle.handleTabClosed('tab-a');
    await pending;
    const current = harness.coordinator.getTask(task.taskId);
    assert.equal(current?.state, 'blocked');
    assert.equal(current?.terminalReason, 'TAB_UNAVAILABLE');
  });

  it('releases a non-execution owned tab without cancelling the child', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    await harness.lifecycle.handleTabCreated(popupEvent({ tabId: 'tab-2' }));
    await harness.lifecycle.handleTabClosed('tab-2');
    assert.equal(harness.coordinator.getTabOwner('tab-2'), undefined);
    assert.equal(harness.childRuns.getActiveChild(task.taskId)?.tabId, 'tab-a');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'running-subgoal');
    agentRuns.hold?.resolve({
      status: 'terminal',
      run: {
        runId: agentRuns.lastRef!.runId,
        tabId: 'tab-a',
        generation: agentRuns.lastRef!.generation,
        instruction: 'x',
        startedAt: 1,
        state: 'cancelled',
        modelStepCount: 0,
        actionAttemptCount: 0,
        approvalCount: 0,
        terminalReason: 'USER_CANCELLED',
      },
    });
    await pending;
  });

  it('blocks an active planning task when the last owned tab closes', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    await harness.lifecycle.handleTabClosed('tab-a');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'blocked');
    assert.equal(harness.coordinator.getTask(task.taskId)?.terminalReason, 'TAB_UNAVAILABLE');
  });

  it('stops a planning task as cancelled', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const stopped = await harness.lifecycle.stop(toAutonomousTaskRef(task));
    assert.equal(stopped.status, 'applied');
    if (stopped.status === 'applied') {
      assert.equal(stopped.snapshot.state, 'cancelled');
      assert.equal(stopped.snapshot.terminalReason, 'USER_CANCELLED');
    }
    assert.equal(harness.lifecycle.resume(toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!)).status, 'ignored');
  });

  it('stops a running child via exact lifecycle cancellation', async () => {
    const agentRuns = new FakeAgentRuns();
    const harness = createLifecycle({ agentRuns });
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = harness.childRuns.execute(childRequest(task));
    await waitForChild(harness.childRuns, task.taskId);
    const stopped = await harness.lifecycle.stop(toAutonomousTaskRef(task));
    await pending;
    assert.equal(stopped.status, 'applied');
    if (stopped.status === 'applied') {
      assert.equal(stopped.snapshot.state, 'cancelled');
    }
    assert.equal(agentRuns.cancelAndWaitCalls[0]?.runId, agentRuns.lastRef?.runId);
  });

  it('gates manual Act on active owned tabs only', async () => {
    const harness = createLifecycle();
    const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    assert.equal(harness.lifecycle.canStartManualAct('tab-a'), false);
    assert.equal(harness.lifecycle.canStartManualAct('tab-b'), true);
    await harness.lifecycle.pause(toAutonomousTaskRef(task));
    assert.equal(harness.lifecycle.canStartManualAct('tab-a'), true);
  });
});

describe('AutonomousTaskLifecycleController source isolation', () => {
  it('does not click, mint grants, or import Electron/IPC/UI', () => {
    const source = readFileSync(path.join(__dirname, 'autonomous-task-lifecycle-controller.ts'), 'utf8');
    for (const token of [
      '.click(',
      '.type(',
      'ExecuteGrant',
      'ApprovalManager',
      "from 'electron'",
      'ipcMain',
      'ConversationStore',
      'AiAnswerEvent',
    ]) {
      assert.equal(source.includes(token), false, token);
    }
    assert.match(source, /startOnCurrentTab\([\s\S]*return this\.startOnTrustedTab\(activeTabId, objective\)/s);
    assert.equal(source.includes('activateTab('), false);
  });
});
