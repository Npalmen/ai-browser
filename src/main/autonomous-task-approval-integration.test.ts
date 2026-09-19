import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import type { AgentRunRef } from '../agent-run/agent-run-types';
import type { SafeAgentLoopOptions, SafeAgentLoopResult } from '../agent-run/safe-agent-loop';
import type {
  AutonomousTaskAgentRunCompletion,
  AutonomousTaskAgentRunExecutionPort,
  AutonomousTaskAgentRunExecutionStartResult,
} from '../autonomous-task/agent-run-execution-port';
import {
  AutonomousTaskChildRunExecutor,
  type AutonomousTaskChildRunRequest,
} from '../autonomous-task/autonomous-task-child-run-executor';
import { AutonomousTaskCoordinator } from '../autonomous-task/autonomous-task-coordinator';
import { AutonomousTaskPlannerExecutor } from '../autonomous-task/autonomous-task-planner-executor';
import {
  MAX_AUTONOMOUS_TASK_APPROVALS,
  toAutonomousTaskRef,
  type AutonomousTaskSnapshot,
} from '../autonomous-task/autonomous-task-types';
import { TaskTabStateRegistry } from '../autonomous-task/task-tab-state-registry';
import type { PreparedActionRecordSnapshot } from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';
import { AgentRunApprovalBridge } from './agent-run-approval-bridge';
import { AgentRunExecutor } from './agent-run-executor';
import { AutonomousTaskApprovalIntegration } from './autonomous-task-approval-integration';
import { CompositeAgentRunApprovalOutcomePort } from './agent-run-approval-outcome-composite';
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

class FakeAgentRuns implements AutonomousTaskAgentRunExecutionPort {
  starts = 0;
  lastRef: AgentRunRef | undefined;
  hold: Deferred<AutonomousTaskAgentRunCompletion> | undefined;
  cancelAndWaitCalls: AgentRunRef[] = [];
  postDispatch = false;
  aborted = false;
  invalidated = false;
  autoResolveCancel = true;
  requestCancellationAfterDispatchCalls: AgentRunRef[] = [];
  drain:
    | { status: 'cancelled' }
    | { status: 'unknown' }
    | { status: 'failed' }
    | { status: 'stale' } = { status: 'cancelled' };

  async start(
    tabId: TabId,
    instruction: string,
  ): Promise<AutonomousTaskAgentRunExecutionStartResult> {
    this.starts += 1;
    const ref: AgentRunRef = { runId: `run-${this.starts}`, tabId, generation: this.starts };
    this.lastRef = ref;
    this.hold = new Deferred();
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
    this.aborted = true;
    this.invalidated = true;
    return ref.runId === this.lastRef?.runId;
  }

  async cancelAndWait(ref: AgentRunRef): Promise<void> {
    this.cancelAndWaitCalls.push(ref);
    if (this.postDispatch) {
      this.requestCancellationAfterDispatchCalls.push(ref);
    } else {
      this.cancel(ref);
    }
    if (this.autoResolveCancel) {
      this.resolveDrain();
    }
    await this.hold?.promise;
  }

  resolveDrain(): void {
    const ref = this.lastRef;
    if (ref === undefined || this.hold === undefined) {
      return;
    }
    if (this.drain.status === 'unknown') {
      this.hold.resolve({
        status: 'terminal',
        run: runSnapshot(ref, 'execution-state-unknown', 'EXECUTION_STATE_UNKNOWN'),
      });
      return;
    }
    if (this.drain.status === 'failed') {
      this.hold.resolve({
        status: 'terminal',
        run: runSnapshot(ref, 'failed', 'ACTION_FAILED'),
      });
      return;
    }
    if (this.drain.status === 'stale') {
      this.hold.resolve({
        status: 'terminal',
        run: runSnapshot(ref, 'blocked', 'ACTION_STALE'),
      });
      return;
    }
    this.hold.resolve({
      status: 'terminal',
      run: runSnapshot(ref, 'cancelled', 'USER_CANCELLED'),
    });
  }
}

function runSnapshot(
  ref: AgentRunRef,
  state: 'cancelled' | 'execution-state-unknown' | 'failed' | 'blocked',
  terminalReason: 'USER_CANCELLED' | 'EXECUTION_STATE_UNKNOWN' | 'ACTION_FAILED' | 'ACTION_STALE',
) {
  return {
    runId: ref.runId,
    tabId: ref.tabId,
    generation: ref.generation,
    instruction: 'child',
    startedAt: 1,
    state,
    modelStepCount: 1,
    actionAttemptCount: 0,
    approvalCount: 1,
    terminalReason,
  };
}

class FakeBrowser {
  activeTabId: TabId = 'tab-a';
  getBrowserState(): { activeTabId: TabId } {
    return { activeTabId: this.activeTabId };
  }
}

class FakeManual {
  isActive(): boolean {
    return false;
  }
}

class HoldingPlanner {
  async plan(): Promise<{ status: 'ignored' }> {
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

async function waitForChild(childRuns: AutonomousTaskChildRunExecutor, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (childRuns.getActiveChild(taskId) !== undefined) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('child did not become active');
}

function createHarness(agentRuns = new FakeAgentRuns()) {
  const coordinator = new AutonomousTaskCoordinator({ generateTaskId: () => 'task-1' });
  const tabState = new TaskTabStateRegistry();
  const childRuns = new AutonomousTaskChildRunExecutor({ coordinator, agentRuns, tabState });
  const integration = new AutonomousTaskApprovalIntegration({ coordinator, childRuns, tabState });
  const planner = new AutonomousTaskPlannerExecutor({ planner: new HoldingPlanner() });
  const lifecycle = new AutonomousTaskLifecycleController({
    coordinator,
    tabState,
    planner,
    childRuns,
    browser: new FakeBrowser(),
    manualRuns: new FakeManual(),
  });
  return { coordinator, tabState, childRuns, integration, lifecycle, agentRuns, planner };
}

async function startChild(harness: ReturnType<typeof createHarness>) {
  const task = harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
  const pending = harness.childRuns.execute(childRequest(task));
  await waitForChild(harness.childRuns, task.taskId);
  return { task, pending, ref: toAutonomousTaskRef(task) };
}

describe('AutonomousTaskApprovalIntegration', () => {
  it('presents the first child approval into awaiting-approval and increments the task count', async () => {
    const harness = createHarness();
    const { task } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId);
    assert.equal(harness.integration.beforePrepare(child!.agentRunRef), 'allow');
    assert.equal(harness.integration.onPresented(child!.agentRunRef, 'appr-1'), 'applied');
    const current = harness.coordinator.getTask(task.taskId);
    assert.equal(current?.state, 'awaiting-approval');
    assert.equal(current?.taskApprovalCount, 1);
  });

  it('resumes running-subgoal after executed and leaves the child active', async () => {
    const harness = createHarness();
    const { task } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    harness.integration.notifyApprovalOutcome('appr-1', 'executed');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'running-subgoal');
    assert.equal(harness.childRuns.getActiveChild(task.taskId)?.agentRunRef.runId, child.agentRunRef.runId);
  });

  it('maps rejected, expired, natural stale, failed, and unknown outcomes', async () => {
    const cases: Array<{
      outcome: 'rejected' | 'expired' | 'stale' | 'failed' | 'execution-state-unknown';
      state: string;
      reason: string;
    }> = [
      { outcome: 'rejected', state: 'blocked', reason: 'APPROVAL_REJECTED' },
      { outcome: 'expired', state: 'blocked', reason: 'APPROVAL_EXPIRED' },
      { outcome: 'stale', state: 'blocked', reason: 'ACTION_STALE' },
      { outcome: 'failed', state: 'failed', reason: 'CHILD_RUN_FAILED' },
      { outcome: 'execution-state-unknown', state: 'execution-state-unknown', reason: 'EXECUTION_STATE_UNKNOWN' },
    ];
    for (const testCase of cases) {
      const harness = createHarness();
      const { task } = await startChild(harness);
      const child = harness.childRuns.getActiveChild(task.taskId)!;
      harness.integration.onPresented(child.agentRunRef, 'appr-1');
      harness.integration.notifyApprovalOutcome('appr-1', testCase.outcome);
      const current = harness.coordinator.getTask(task.taskId);
      assert.equal(current?.state, testCase.state, testCase.outcome);
      assert.equal(current?.terminalReason, testCase.reason, testCase.outcome);
      assert.equal(harness.tabState.getToken(task.taskId, 'task-tab-1'), undefined);
    }
  });

  it('allows four presentations and blocks the fifth before prepare', async () => {
    const harness = createHarness();
    const { task } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    for (let index = 1; index <= MAX_AUTONOMOUS_TASK_APPROVALS; index += 1) {
      assert.equal(harness.integration.beforePrepare(child.agentRunRef), 'allow');
      assert.equal(harness.integration.onPresented(child.agentRunRef, `appr-${index}`), 'applied');
      harness.integration.notifyApprovalOutcome(`appr-${index}`, 'executed');
    }
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 4);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'running-subgoal');
    assert.equal(harness.integration.beforePrepare(child.agentRunRef), 'blocked');
    const blocked = harness.coordinator.getTask(task.taskId);
    assert.equal(blocked?.state, 'blocked');
    assert.equal(blocked?.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(blocked?.taskApprovalCount, 4);
  });

  it('increments independently for two approvals and across child runs', async () => {
    const harness = createHarness();
    const { task, pending } = await startChild(harness);
    const first = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(first.agentRunRef, 'appr-a');
    harness.integration.notifyApprovalOutcome('appr-a', 'executed');
    harness.integration.onPresented(first.agentRunRef, 'appr-b');
    harness.integration.notifyApprovalOutcome('appr-b', 'executed');
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 2);
    harness.agentRuns.hold?.resolve({
      status: 'completed',
      run: {
        ...runSnapshot(first.agentRunRef, 'cancelled', 'USER_CANCELLED'),
        state: 'completed',
        terminalReason: 'COMPLETED',
      },
      answer: {
        text: 'subgoal done',
        referencedTargets: [],
        alias: 'page-standard',
        truncatedContext: false,
        documentRevision: 'rev-1',
      },
    });
    assert.equal((await pending).status, 'completed');

    const secondPending = harness.childRuns.execute({
      ref: toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!),
      taskTabAlias: 'task-tab-1',
      instruction: 'Confirm the fare',
    });
    await waitForChild(harness.childRuns, task.taskId);
    const second = harness.childRuns.getActiveChild(task.taskId)!;
    assert.notEqual(second.agentRunRef.runId, first.agentRunRef.runId);
    harness.integration.onPresented(second.agentRunRef, 'appr-c');
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 3);
    harness.agentRuns.hold?.resolve({
      status: 'terminal',
      run: runSnapshot(second.agentRunRef, 'cancelled', 'USER_CANCELLED'),
    });
    await secondPending;
  });

  it('does not correlate unrelated manual AgentRuns', async () => {
    const harness = createHarness();
    const { task } = await startChild(harness);
    const manual: AgentRunRef = { runId: 'manual-run', tabId: 'tab-other', generation: 1 };
    assert.equal(harness.integration.beforePrepare(manual), 'unrelated');
    assert.equal(harness.integration.onPresented(manual, 'appr-manual'), 'unrelated');
    harness.integration.notifyApprovalOutcome('appr-manual', 'executed');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'running-subgoal');
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 0);
  });

  it('does not correlate paused-task manual Act by tab ownership', async () => {
    const harness = createHarness();
    const { task, pending } = await startChild(harness);
    harness.agentRuns.hold?.resolve({
      status: 'completed',
      run: {
        runId: harness.agentRuns.lastRef!.runId,
        tabId: harness.agentRuns.lastRef!.tabId,
        generation: harness.agentRuns.lastRef!.generation,
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
    await pending;
    await harness.lifecycle.pause(toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!));
    const ownedTab = harness.coordinator.getOwnedTabs(task.taskId)[0]?.tabId;
    const manual: AgentRunRef = { runId: 'manual-owned', tabId: ownedTab ?? 'tab-a', generation: 9 };
    assert.equal(harness.integration.beforePrepare(manual), 'unrelated');
    assert.equal(harness.integration.onPresented(manual, 'appr-owned-manual'), 'unrelated');
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 0);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'paused');
  });

  it('ignores late duplicate outcomes after a later approval is presented', async () => {
    const harness = createHarness();
    const { task } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-a');
    harness.integration.notifyApprovalOutcome('appr-a', 'executed');
    harness.integration.onPresented(child.agentRunRef, 'appr-b');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'awaiting-approval');
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 2);
    harness.integration.notifyApprovalOutcome('appr-a', 'rejected');
    const current = harness.coordinator.getTask(task.taskId);
    assert.equal(current?.state, 'awaiting-approval');
    assert.equal(current?.taskApprovalCount, 2);
    assert.equal(current?.terminalReason, undefined);
  });

  it('does not treat free-text as approval', async () => {
    const harness = createHarness();
    const { task } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    assert.equal(
      harness.integration.considerUserReply(toAutonomousTaskRef(task), 'yes, approve it'),
      'ignored',
    );
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'awaiting-approval');
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 1);
  });

  it('does not start planner or a new child while awaiting approval', async () => {
    const harness = createHarness();
    const { task } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    const ref = toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!);
    assert.throws(() => harness.coordinator.assertCanStartPlannerStep(ref));
    assert.throws(() => harness.coordinator.beginChildRun(ref));
    assert.equal(harness.planner.hasActive(task.taskId), false);
  });

  it('does not increment the count when presentation cannot be correlated', async () => {
    const harness = createHarness();
    harness.lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const stray: AgentRunRef = { runId: 'missing', tabId: 'tab-a', generation: 1 };
    assert.equal(harness.integration.onPresented(stray, 'appr-1'), 'unrelated');
    assert.equal(harness.coordinator.getTask('task-1')?.taskApprovalCount, 0);
  });
});

describe('AutonomousTask approval lifecycle races', () => {
  it('pauses awaiting-approval on predispatch stale without ACTION_STALE', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.drain = { status: 'stale' };
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    const paused = await harness.lifecycle.pause(toAutonomousTaskRef(task));
    const childResult = await pending;
    assert.equal(childResult.status, 'lifecycle-cancelled');
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'paused');
    }
    assert.equal(harness.coordinator.getTask(task.taskId)?.terminalReason, undefined);
    assert.equal(harness.coordinator.getTask(task.taskId)?.taskApprovalCount, 1);
    harness.integration.notifyApprovalOutcome('appr-1', 'executed');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'paused');
  });

  it('pauses post-dispatch after executed without aborting or invalidating', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.postDispatch = true;
    agentRuns.autoResolveCancel = false;
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    const pausePromise = harness.lifecycle.pause(toAutonomousTaskRef(task));
    assert.equal(agentRuns.aborted, false);
    assert.equal(agentRuns.invalidated, false);
    assert.equal(agentRuns.requestCancellationAfterDispatchCalls[0]?.runId, child.agentRunRef.runId);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'awaiting-approval');
    harness.integration.notifyApprovalOutcome('appr-1', 'executed');
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'awaiting-approval');
    agentRuns.resolveDrain();
    const paused = await pausePromise;
    await pending;
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'paused');
    }
  });

  it('lets unknown win over post-dispatch Pause', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.postDispatch = true;
    agentRuns.autoResolveCancel = false;
    agentRuns.drain = { status: 'unknown' };
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    const pausePromise = harness.lifecycle.pause(toAutonomousTaskRef(task));
    harness.integration.notifyApprovalOutcome('appr-1', 'execution-state-unknown');
    agentRuns.resolveDrain();
    const paused = await pausePromise;
    await pending;
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'execution-state-unknown');
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'execution-state-unknown');
    }
  });

  it('stops awaiting-approval predispatch as cancelled, not ACTION_STALE', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.drain = { status: 'stale' };
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    const stopped = await harness.lifecycle.stop(toAutonomousTaskRef(task));
    await pending;
    assert.equal(stopped.status, 'applied');
    if (stopped.status === 'applied') {
      assert.equal(stopped.snapshot.state, 'cancelled');
      assert.equal(stopped.snapshot.terminalReason, 'USER_CANCELLED');
    }
    assert.equal(
      harness.lifecycle.resume(toAutonomousTaskRef(harness.coordinator.getTask(task.taskId)!)).status,
      'ignored',
    );
  });

  it('stops post-dispatch executed as cancelled and unknown as unknown', async () => {
    const executedRuns = new FakeAgentRuns();
    executedRuns.postDispatch = true;
    executedRuns.autoResolveCancel = false;
    const executedHarness = createHarness(executedRuns);
    const executed = await startChild(executedHarness);
    executedHarness.integration.onPresented(
      executedHarness.childRuns.getActiveChild(executed.task.taskId)!.agentRunRef,
      'appr-1',
    );
    const stopExecuted = executedHarness.lifecycle.stop(toAutonomousTaskRef(executed.task));
    executedHarness.integration.notifyApprovalOutcome('appr-1', 'executed');
    executedRuns.resolveDrain();
    const executedResult = await stopExecuted;
    await executed.pending;
    assert.equal(executedResult.status, 'applied');
    if (executedResult.status === 'applied') {
      assert.equal(executedResult.snapshot.state, 'cancelled');
    }

    const unknownRuns = new FakeAgentRuns();
    unknownRuns.postDispatch = true;
    unknownRuns.autoResolveCancel = false;
    unknownRuns.drain = { status: 'unknown' };
    const unknownHarness = createHarness(unknownRuns);
    const unknown = await startChild(unknownHarness);
    unknownHarness.integration.onPresented(
      unknownHarness.childRuns.getActiveChild(unknown.task.taskId)!.agentRunRef,
      'appr-1',
    );
    const stopUnknown = unknownHarness.lifecycle.stop(toAutonomousTaskRef(unknown.task));
    unknownHarness.integration.notifyApprovalOutcome('appr-1', 'execution-state-unknown');
    unknownRuns.resolveDrain();
    const unknownResult = await stopUnknown;
    await unknown.pending;
    assert.equal(unknownHarness.coordinator.getTask(unknown.task.taskId)?.state, 'execution-state-unknown');
    if (unknownResult.status === 'applied') {
      assert.equal(unknownResult.snapshot.state, 'execution-state-unknown');
    }
  });

  it('treats tab-close while awaiting approval as TAB_UNAVAILABLE, not ACTION_STALE', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.drain = { status: 'stale' };
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    await harness.lifecycle.handleTabClosed('tab-a');
    await pending;
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'blocked');
    assert.equal(harness.coordinator.getTask(task.taskId)?.terminalReason, 'TAB_UNAVAILABLE');
  });

  it('lets unknown win over tab-close while awaiting approval', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.postDispatch = true;
    agentRuns.autoResolveCancel = false;
    agentRuns.drain = { status: 'unknown' };
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    const closed = harness.lifecycle.handleTabClosed('tab-a');
    harness.integration.notifyApprovalOutcome('appr-1', 'execution-state-unknown');
    agentRuns.resolveDrain();
    await closed;
    await pending;
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'execution-state-unknown');
  });

  it('uses approval-aware Pause for trusted chrome navigation', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.drain = { status: 'stale' };
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    await harness.lifecycle.beforeTrustedChromeNavigation('tab-a');
    await pending;
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'paused');
    assert.equal(harness.childRuns.getActiveChild(task.taskId), undefined);
  });

  it('defers fourth-popup terminalization while awaiting approval until V4 executed', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.postDispatch = true;
    agentRuns.autoResolveCancel = false;
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    await harness.lifecycle.handleTabCreated({
      tabId: 'tab-2',
      cause: 'website-popup',
      sourceTabId: 'tab-a',
      causedByAgentInputDispatch: true,
    });
    await harness.lifecycle.handleTabCreated({
      tabId: 'tab-3',
      cause: 'website-popup',
      sourceTabId: 'tab-a',
      causedByAgentInputDispatch: true,
    });
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    assert.equal(harness.coordinator.getTask(task.taskId)?.ownedTabCount, 3);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'awaiting-approval');
    const created = harness.lifecycle.handleTabCreated({
      tabId: 'tab-4',
      cause: 'website-popup',
      sourceTabId: 'tab-a',
      causedByAgentInputDispatch: true,
    });
    assert.equal(harness.coordinator.getTabOwner('tab-4'), undefined);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'awaiting-approval');
    assert.equal(harness.coordinator.getTask(task.taskId)?.terminalReason, undefined);
    assert.equal(agentRuns.requestCancellationAfterDispatchCalls[0]?.runId, child.agentRunRef.runId);
    harness.integration.notifyApprovalOutcome('appr-1', 'executed');
    agentRuns.resolveDrain();
    await created;
    await pending;
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'blocked');
    assert.equal(harness.coordinator.getTask(task.taskId)?.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(harness.coordinator.getTabOwner('tab-4'), undefined);
  });

  it('defers fourth-popup unknown without TASK_LIMIT_REACHED', async () => {
    const agentRuns = new FakeAgentRuns();
    agentRuns.postDispatch = true;
    agentRuns.autoResolveCancel = false;
    agentRuns.drain = { status: 'unknown' };
    const harness = createHarness(agentRuns);
    const { task, pending } = await startChild(harness);
    await harness.lifecycle.handleTabCreated({
      tabId: 'tab-2',
      cause: 'website-popup',
      sourceTabId: 'tab-a',
      causedByAgentInputDispatch: true,
    });
    await harness.lifecycle.handleTabCreated({
      tabId: 'tab-3',
      cause: 'website-popup',
      sourceTabId: 'tab-a',
      causedByAgentInputDispatch: true,
    });
    const child = harness.childRuns.getActiveChild(task.taskId)!;
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    const created = harness.lifecycle.handleTabCreated({
      tabId: 'tab-4',
      cause: 'website-popup',
      sourceTabId: 'tab-a',
      causedByAgentInputDispatch: true,
    });
    harness.integration.notifyApprovalOutcome('appr-1', 'execution-state-unknown');
    agentRuns.resolveDrain();
    await created;
    await pending;
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'execution-state-unknown');
    assert.notEqual(harness.coordinator.getTask(task.taskId)?.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(harness.coordinator.getTabOwner('tab-4'), undefined);
  });
});

describe('AgentRunExecutor pause post-dispatch with task approval', () => {
  it('does not abort or invalidate after adapterPrimitiveInvoked', async () => {
    class FakeLoop {
      aborted = false;
      hold = new Deferred<SafeAgentLoopResult>();
      run(_ref: AgentRunRef, options: SafeAgentLoopOptions): Promise<SafeAgentLoopResult> {
        options.signal?.addEventListener('abort', () => {
          this.aborted = true;
        });
        return this.hold.promise;
      }
    }
    class FakeManager {
      snapshot: PreparedActionRecordSnapshot | undefined;
      getSnapshot(): PreparedActionRecordSnapshot | undefined {
        return this.snapshot;
      }
    }
    class FakeInvalidate {
      invalidated: TabId[] = [];
      invalidateTab(tabId: TabId): void {
        this.invalidated.push(tabId);
      }
    }
    const loop = new FakeLoop();
    const manager = new FakeManager();
    const invalidate = new FakeInvalidate();
    const agentRuns = new AgentRunCoordinator();
    const executor = new AgentRunExecutor({
      coordinator: agentRuns,
      loop,
      manager,
      lifecycle: invalidate,
    });
    const coordinator = new AutonomousTaskCoordinator({ generateTaskId: () => 'task-1' });
    const tabState = new TaskTabStateRegistry();
    const childRuns = new AutonomousTaskChildRunExecutor({
      coordinator,
      agentRuns: {
        start: (tabId, instruction, options) => executor.start(tabId, instruction, options),
        cancel: (ref, reason) => executor.cancel(ref, reason),
        cancelAndWait: (ref, reason) => executor.cancelAndWait(ref, reason),
      },
      tabState,
    });
    const integration = new AutonomousTaskApprovalIntegration({ coordinator, childRuns, tabState });
    const planner = new AutonomousTaskPlannerExecutor({ planner: new HoldingPlanner() });
    const lifecycle = new AutonomousTaskLifecycleController({
      coordinator,
      tabState,
      planner,
      childRuns,
      browser: new FakeBrowser(),
      manualRuns: new FakeManual(),
    });
    const task = lifecycle.startOnCurrentTab('Book the cheapest refundable flight');
    const pending = childRuns.execute(childRequest(task));
    await waitForChild(childRuns, task.taskId);
    const child = childRuns.getActiveChild(task.taskId)!;
    agentRuns.presentApproval(child.agentRunRef, 'appr-1');
    integration.onPresented(child.agentRunRef, 'appr-1');
    manager.snapshot = {
      action: {
        preparedActionId: 'prep-1',
        approvalId: 'appr-1',
        kind: 'click',
        tabId: 'tab-a',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
        targetId: 'target-1',
        category: 'purchase',
        summary: { title: 'Buy now' },
        createdAt: 1,
        expiresAt: 2,
        state: 'executing',
      },
      facts: {
        grantIssued: true,
        grantClaimed: true,
        adapterPrimitiveInvoked: true,
        postObservationSucceeded: false,
      },
    };
    const pausePromise = lifecycle.pause(toAutonomousTaskRef(task));
    assert.equal(loop.aborted, false);
    assert.deepEqual(invalidate.invalidated, []);
    const composite = new CompositeAgentRunApprovalOutcomePort({
      task: integration,
      agentRun: agentRuns,
    });
    composite.notifyApprovalOutcome('appr-1', 'executed');
    const notified = agentRuns.getRun(child.agentRunRef.runId);
    loop.hold.resolve({
      status: 'terminal',
      run: notified ?? {
        ...child.agentRunRef,
        instruction: 'x',
        startedAt: 1,
        state: 'cancelled',
        modelStepCount: 0,
        actionAttemptCount: 1,
        approvalCount: 1,
        terminalReason: 'USER_CANCELLED',
      },
    });
    const paused = await pausePromise;
    await pending;
    assert.equal(loop.aborted, false);
    assert.deepEqual(invalidate.invalidated, []);
    assert.equal(paused.status, 'applied');
    if (paused.status === 'applied') {
      assert.equal(paused.snapshot.state, 'paused');
    }
  });
});

describe('AutonomousTaskApprovalIntegration source isolation', () => {
  it('does not mint grants, click, or use Electron/IPC/React', () => {
    const source = readFileSync(path.join(__dirname, 'autonomous-task-approval-integration.ts'), 'utf8');
    for (const token of [
      'BrowserAdapter',
      'ExecuteGrant',
      'claimExecuteGrant',
      '.click(',
      '.type(',
      '.select(',
      "from 'electron'",
      'ipcMain',
      'from "react"',
      'ApprovalWorkflowController',
      'ApprovalController',
      'approveTask',
    ]) {
      assert.equal(source.includes(token), false, token);
    }
  });

  it('does not put taskId on V4 authority types', () => {
    const types = readFileSync(path.join(__dirname, '..', 'shared', 'approval-types.ts'), 'utf8');
    assert.equal(types.includes('taskId'), false);
    assert.equal(types.includes('taskGeneration'), false);
    assert.equal(types.includes('taskApprovalCount'), false);
  });
});
