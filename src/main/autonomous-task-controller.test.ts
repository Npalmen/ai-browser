import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ModelError } from '../ai/model-errors';
import type { AgentRunRef } from '../agent-run/agent-run-types';
import type { TabId } from '../shared/browser-types';
import type {
  AutonomousTaskAgentRunCompletion,
  AutonomousTaskAgentRunExecutionPort,
  AutonomousTaskAgentRunExecutionStartResult,
} from '../autonomous-task/agent-run-execution-port';
import { AutonomousTaskChildRunExecutor } from '../autonomous-task/autonomous-task-child-run-executor';
import { AutonomousTaskCoordinator } from '../autonomous-task/autonomous-task-coordinator';
import type { AutonomousTaskDecision } from '../autonomous-task/autonomous-task-decision';
import type { AutonomousTaskPlanner, AutonomousTaskPlannerResult } from '../autonomous-task/autonomous-task-planner';
import type { AutonomousTaskPlannerInput } from '../autonomous-task/autonomous-task-planner-context';
import { AutonomousTaskPlannerExecutor } from '../autonomous-task/autonomous-task-planner-executor';
import { TaskTabStateRegistry } from '../autonomous-task/task-tab-state-registry';
import type { AutonomousTaskRef } from '../autonomous-task/autonomous-task-types';
import type { AutonomousTaskEvent } from '../shared/autonomous-task-types';
import { AutonomousTaskApprovalIntegration } from './autonomous-task-approval-integration';
import { AutonomousTaskController } from './autonomous-task-controller';
import { AutonomousTaskLifecycleController } from './autonomous-task-lifecycle-controller';

const FORBIDDEN_EVENT_FIELDS = [
  'targetId',
  'observationId',
  'documentRevision',
  'backendDOMNodeId',
  'frameId',
  'approvalId',
  'preparedActionId',
  'executionId',
  'ExecuteGrant',
  'InteractionGrant',
  'runId',
  'AgentRunRef',
  'generation',
];

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class FakeBrowser {
  activeTabId: TabId = 'tab-a';

  getBrowserState(): { activeTabId: TabId } {
    return { activeTabId: this.activeTabId };
  }
}

class FakeManual {
  readonly active = new Set<TabId>();

  isActive(tabId: TabId): boolean {
    return this.active.has(tabId);
  }
}

class ScriptedPlanner implements Pick<AutonomousTaskPlanner, 'plan'> {
  readonly inputs: AutonomousTaskPlannerInput[] = [];
  decisions: AutonomousTaskDecision[] = [];
  hold: Deferred<AutonomousTaskPlannerResult> | undefined;
  failWith: ModelError | undefined;

  constructor(private readonly coordinator: AutonomousTaskCoordinator) {}

  async plan(
    ref: AutonomousTaskRef,
    input: AutonomousTaskPlannerInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<AutonomousTaskPlannerResult> {
    this.inputs.push(input);
    if (options.signal?.aborted) {
      throw new ModelError('REQUEST_CANCELLED', 'cancelled');
    }
    if (this.hold !== undefined) {
      const held = this.hold;
      return await new Promise<AutonomousTaskPlannerResult>((resolve, reject) => {
        const onAbort = () => {
          reject(new ModelError('REQUEST_CANCELLED', 'cancelled'));
        };
        options.signal?.addEventListener('abort', onAbort);
        void held.promise.then(
          (result) => {
            options.signal?.removeEventListener('abort', onAbort);
            if (options.signal?.aborted) {
              reject(new ModelError('REQUEST_CANCELLED', 'cancelled'));
              return;
            }
            if (result.status === 'decision') {
              this.coordinator.recordPlannerStepCompleted(ref);
            }
            resolve(result);
          },
          (error: unknown) => {
            options.signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    }
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    const decision = this.decisions.shift();
    if (decision === undefined) {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'no scripted decision');
    }
    this.coordinator.recordPlannerStepCompleted(ref);
    return { status: 'decision', decision, alias: 'page-standard' };
  }
}

class ImmediateAgentRuns implements AutonomousTaskAgentRunExecutionPort {
  starts = 0;
  lastInstruction: string | undefined;

  async start(
    tabId: TabId,
    instruction: string,
  ): Promise<AutonomousTaskAgentRunExecutionStartResult> {
    this.starts += 1;
    this.lastInstruction = instruction;
    const ref: AgentRunRef = { runId: `run-${this.starts}`, tabId, generation: this.starts };
    return {
      status: 'started',
      run: snapshot(ref, instruction, 'completed'),
      ref,
      completion: Promise.resolve(completed(ref, instruction, `child-${this.starts}`)),
    };
  }

  cancel(): boolean {
    return true;
  }

  async cancelAndWait(): Promise<void> {}
}

class HoldingAgentRuns implements AutonomousTaskAgentRunExecutionPort {
  starts = 0;
  lastRef: AgentRunRef | undefined;
  hold: Deferred<AutonomousTaskAgentRunCompletion> | undefined;
  started = new Deferred<void>();

  async start(
    tabId: TabId,
    instruction: string,
  ): Promise<AutonomousTaskAgentRunExecutionStartResult> {
    this.starts += 1;
    const ref: AgentRunRef = { runId: `run-${this.starts}`, tabId, generation: this.starts };
    this.lastRef = ref;
    this.hold = new Deferred();
    this.started.resolve();
    this.started = new Deferred();
    return {
      status: 'started',
      run: snapshot(ref, instruction, 'running'),
      ref,
      completion: this.hold.promise,
    };
  }

  cancel(): boolean {
    return true;
  }

  async cancelAndWait(ref: AgentRunRef): Promise<void> {
    this.hold?.resolve({
      status: 'terminal',
      run: snapshot(ref, 'child', 'cancelled'),
    });
    await this.hold?.promise;
  }
}

function snapshot(
  ref: AgentRunRef,
  instruction: string,
  state: 'running' | 'completed' | 'cancelled',
) {
  return {
    runId: ref.runId,
    tabId: ref.tabId,
    generation: ref.generation,
    instruction,
    startedAt: 1,
    state,
    modelStepCount: state === 'completed' ? 1 : 0,
    actionAttemptCount: 0,
    approvalCount: 0,
    ...(state === 'completed' ? { terminalReason: 'COMPLETED' as const } : {}),
    ...(state === 'cancelled' ? { terminalReason: 'USER_CANCELLED' as const } : {}),
  };
}

function completed(
  ref: AgentRunRef,
  instruction: string,
  text: string,
): AutonomousTaskAgentRunCompletion {
  return {
    status: 'completed',
    run: snapshot(ref, instruction, 'completed'),
    answer: {
      text,
      referencedTargets: [],
      alias: 'page-standard',
      truncatedContext: false,
      documentRevision: 'rev-1',
    },
  };
}

function delegate(instruction: string): AutonomousTaskDecision {
  return { kind: 'delegate-subgoal', taskTabAlias: 'task-tab-1', instruction };
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }
  if (typeof value !== 'object' || value === undefined || value === null) {
    return keys;
  }
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectKeys(nested, keys);
  }
  return keys;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createHarness(options: { holdingChild?: boolean } = {}) {
  const events: AutonomousTaskEvent[] = [];
  const coordinator = new AutonomousTaskCoordinator({ generateTaskId: () => 'task-1' });
  const tabState = new TaskTabStateRegistry();
  const plannerImpl = new ScriptedPlanner(coordinator);
  const planner = new AutonomousTaskPlannerExecutor({ planner: plannerImpl });
  const agentRuns = options.holdingChild ? new HoldingAgentRuns() : new ImmediateAgentRuns();
  const childRuns = new AutonomousTaskChildRunExecutor({ coordinator, agentRuns, tabState });
  const integration = new AutonomousTaskApprovalIntegration({
    coordinator,
    childRuns,
    tabState,
    onTaskChanged: (taskId) => controller.handleTaskChanged(taskId),
  });
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
  const controller = new AutonomousTaskController({
    coordinator,
    lifecycle,
    planner,
    childRuns,
    emit: (event) => events.push(event),
  });
  return {
    events,
    coordinator,
    plannerImpl,
    agentRuns,
    childRuns,
    integration,
    browser,
    lifecycle,
    controller,
  };
}

describe('AutonomousTaskController', () => {
  it('runs sequential subgoals and commits one completed delegation turn', async () => {
    const harness = createHarness();
    harness.plannerImpl.decisions = [
      delegate('Compare fares on task-tab-1'),
      delegate('Open the refund policy'),
      { kind: 'complete', answer: 'The cheapest refundable fare is 214 euros.' },
    ];
    const started = harness.controller.start('Book the cheapest refundable flight');
    assert.equal(started.ok, true);
    await waitUntil(
      () => harness.events.some((event) => event.type === 'autonomous-task-completed'),
      'completed',
    );
    const snapshot = harness.coordinator.getTask('task-1');
    assert.equal(snapshot?.state, 'completed');
    assert.equal(snapshot?.plannerStepCount, 3);
    assert.equal(snapshot?.childRunCount, 2);
    assert.equal(harness.agentRuns.starts, 2);
    const turns = harness.controller.getCompletedDelegationTurns();
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.objective, 'Book the cheapest refundable flight');
    assert.equal(turns[0]?.answer, 'The cheapest refundable fare is 214 euros.');
    for (const event of harness.events) {
      const keys = collectKeys(event);
      for (const forbidden of FORBIDDEN_EVENT_FIELDS) {
        assert.equal(keys.has(forbidden), false, forbidden);
      }
      assert.equal(JSON.stringify(event).includes('Compare fares'), false);
    }
  });

  it('suspends for user input, preserves clarification across pause, and does not treat reply as approval', async () => {
    const harness = createHarness();
    harness.plannerImpl.decisions = [
      { kind: 'request-user-input', question: 'Which cabin class?' },
    ];
    harness.controller.start('Book a flight');
    await waitUntil(
      () => harness.events.some((event) => event.type === 'autonomous-task-awaiting-user-input'),
      'awaiting-user-input',
    );
    const questionEvent = harness.events.find((event) => event.type === 'autonomous-task-awaiting-user-input');
    assert.equal(questionEvent?.task.question, 'Which cabin class?');
    assert.equal(questionEvent?.task.attention, 'user-input');

    harness.plannerImpl.hold = new Deferred();
    const replied = harness.controller.reply('task-1', 'economy');
    assert.equal(replied.ok, true);
    await waitUntil(() => harness.plannerImpl.inputs.length === 2, 'second planner');
    const paused = await harness.controller.pause('task-1');
    assert.equal(paused.ok, true);
    assert.equal(harness.coordinator.getTask('task-1')?.state, 'paused');
    harness.plannerImpl.hold = undefined;
    harness.plannerImpl.decisions = [{ kind: 'complete', answer: 'Booked economy.' }];
    const resumed = harness.controller.resume('task-1');
    assert.equal(resumed.ok, true);
    await waitUntil(
      () => harness.events.some((event) => event.type === 'autonomous-task-completed'),
      'completed after reply',
    );
    assert.equal(harness.plannerImpl.inputs.at(-1)?.userClarification, 'economy');
    assert.equal(harness.controller.getCompletedDelegationTurns().length, 1);
  });

  it('ignores free-text replies while awaiting approval', async () => {
    const harness = createHarness({ holdingChild: true });
    harness.plannerImpl.decisions = [delegate('Submit the form')];
    harness.controller.start('Submit checkout');
    await waitUntil(() => harness.childRuns.getActiveChild('task-1') !== undefined, 'child');
    const child = harness.childRuns.getActiveChild('task-1');
    assert.ok(child);
    harness.integration.onPresented(child.agentRunRef, 'appr-1');
    await waitUntil(
      () => harness.events.some((event) => event.type === 'autonomous-task-awaiting-approval'),
      'awaiting-approval',
    );
    const approvalEvent = harness.events.find((event) => event.type === 'autonomous-task-awaiting-approval');
    assert.equal(approvalEvent?.task.attention, 'approval');
    assert.equal(approvalEvent?.task.attentionTabId, 'tab-a');
    assert.equal(JSON.stringify(approvalEvent).includes('appr-1'), false);
    const reply = harness.controller.reply('task-1', 'approve');
    assert.equal(reply.ok, false);
    assert.equal(harness.coordinator.getTask('task-1')?.state, 'awaiting-approval');
    assert.equal(harness.plannerImpl.inputs.length, 1);
  });

  it('pauses an in-flight planner and ignores the stale result on resume', async () => {
    const harness = createHarness();
    harness.plannerImpl.hold = new Deferred();
    harness.controller.start('Research hotels');
    await waitUntil(() => harness.plannerImpl.inputs.length === 1, 'planner started');
    const paused = await harness.controller.pause('task-1');
    assert.equal(paused.ok, true);
    assert.equal(harness.coordinator.getTask('task-1')?.state, 'paused');
    harness.plannerImpl.hold.resolve({
      status: 'decision',
      decision: delegate('stale child'),
      alias: 'page-standard',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((harness.agentRuns as ImmediateAgentRuns).starts, 0);
    harness.plannerImpl.hold = undefined;
    harness.plannerImpl.decisions = [{ kind: 'complete', answer: 'No hotels needed.' }];
    harness.controller.resume('task-1');
    await waitUntil(
      () => harness.events.some((event) => event.type === 'autonomous-task-completed'),
      'completed after resume',
    );
    assert.equal((harness.agentRuns as ImmediateAgentRuns).starts, 0);
    assert.equal(harness.plannerImpl.inputs.length, 2);
  });

  it('continues while the user activates another tab', async () => {
    const harness = createHarness();
    harness.plannerImpl.hold = new Deferred();
    harness.controller.start('Keep working in the background');
    await waitUntil(() => harness.plannerImpl.inputs.length === 1, 'planner started');
    harness.browser.activeTabId = 'tab-b';
    assert.equal(harness.coordinator.getTask('task-1')?.state, 'planning');
    harness.plannerImpl.hold.resolve({
      status: 'decision',
      decision: { kind: 'complete', answer: 'Still running in the background.' },
      alias: 'page-standard',
    });
    await waitUntil(
      () => harness.events.some((event) => event.type === 'autonomous-task-completed'),
      'background complete',
    );
    assert.equal(harness.browser.activeTabId, 'tab-b');
  });

  it('does not commit history for blocked, cancelled, failed, or unknown tasks', async () => {
    const cancelled = createHarness();
    cancelled.plannerImpl.hold = new Deferred();
    cancelled.controller.start('Will cancel');
    await waitUntil(() => cancelled.plannerImpl.inputs.length === 1, 'planner');
    await cancelled.controller.stop('task-1');
    assert.equal(cancelled.coordinator.getTask('task-1')?.state, 'cancelled');
    assert.equal(cancelled.controller.getCompletedDelegationTurns().length, 0);

    const failed = createHarness();
    failed.plannerImpl.failWith = new ModelError('MODEL_UNAVAILABLE', 'down');
    failed.controller.start('Will fail');
    await waitUntil(
      () => failed.events.some((event) => event.type === 'autonomous-task-failed'),
      'failed',
    );
    assert.equal(failed.coordinator.getTask('task-1')?.terminalReason, 'PLANNER_FAILED');
    assert.equal(failed.controller.getCompletedDelegationTurns().length, 0);

    const unknown = createHarness({ holdingChild: true });
    unknown.plannerImpl.decisions = [delegate('Click purchase')];
    unknown.controller.start('Will go unknown');
    await waitUntil(() => unknown.childRuns.getActiveChild('task-1') !== undefined, 'child');
    const child = unknown.childRuns.getActiveChild('task-1');
    assert.ok(child);
    unknown.integration.onPresented(child.agentRunRef, 'appr-unknown');
    unknown.integration.notifyApprovalOutcome('appr-unknown', 'execution-state-unknown');
    await waitUntil(
      () => unknown.events.some((event) => event.type === 'autonomous-task-execution-state-unknown'),
      'unknown',
    );
    assert.equal(unknown.controller.getCompletedDelegationTurns().length, 0);
  });

  it('dispose aborts live work and ignores late results', async () => {
    const harness = createHarness();
    harness.plannerImpl.hold = new Deferred();
    harness.controller.start('Will dispose');
    await waitUntil(() => harness.plannerImpl.inputs.length === 1, 'planner');
    const before = harness.events.length;
    harness.controller.dispose();
    harness.plannerImpl.hold.resolve({
      status: 'decision',
      decision: delegate('late'),
      alias: 'page-standard',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.events.length, before);
    assert.deepEqual(harness.controller.getState(), []);
    assert.equal(harness.controller.getCompletedDelegationTurns().length, 0);
  });

  it('rejects a second active start and resume while another task is active', async () => {
    let nextId = 0;
    const events: AutonomousTaskEvent[] = [];
    const coordinator = new AutonomousTaskCoordinator({ generateTaskId: () => `task-${++nextId}` });
    const tabState = new TaskTabStateRegistry();
    const plannerImpl = new ScriptedPlanner(coordinator);
    plannerImpl.hold = new Deferred();
    const planner = new AutonomousTaskPlannerExecutor({ planner: plannerImpl });
    const agentRuns = new ImmediateAgentRuns();
    const childRuns = new AutonomousTaskChildRunExecutor({ coordinator, agentRuns, tabState });
    const browser = new FakeBrowser();
    const lifecycle = new AutonomousTaskLifecycleController({
      coordinator,
      tabState,
      planner,
      childRuns,
      browser,
      manualRuns: new FakeManual(),
    });
    const controller = new AutonomousTaskController({
      coordinator,
      lifecycle,
      planner,
      childRuns,
      emit: (event) => events.push(event),
    });
    const first = controller.start('First');
    assert.equal(first.ok, true);
    const blocked = controller.start('Second');
    assert.equal(blocked.ok, false);
    await controller.pause('task-1');
    browser.activeTabId = 'tab-b';
    plannerImpl.hold = new Deferred();
    const second = controller.start('Second');
    assert.equal(second.ok, true);
    if (!second.ok) {
      throw new Error('expected second start');
    }
    const resume = controller.resume('task-1');
    assert.equal(resume.ok, false);
    assert.equal(coordinator.getTask('task-1')?.state, 'paused');
    assert.equal(coordinator.getActiveTask()?.taskId, second.task.taskId);
  });

  it('does not include chain-of-thought or planner instruction in renderer events', () => {
    const source = readFileSync(path.join(__dirname, 'autonomous-task-controller.ts'), 'utf8');
    assert.equal(source.includes('setInterval'), false);
    assert.equal(source.includes('while (true)'), false);
    assert.match(source, /planner\.plan\(/);
    assert.match(source, /childRuns\.execute\(/);
    assert.equal(source.includes('AgentRunExecutor'), false);
    assert.equal(source.includes('ApprovalController'), false);
    assert.equal(source.includes('approval:decide'), false);
  });
});

describe('autonomous task renderer contract', () => {
  it('keeps renderer types free of authority handles', () => {
    const files = [
      'src/shared/autonomous-task-types.ts',
      'src/app-ui/AutonomousTaskCard.tsx',
      'src/app-ui/autonomous-task-ui-state.ts',
    ];
    for (const relative of files) {
      const source = readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
      for (const forbidden of [
        'approvalId',
        'preparedActionId',
        'executionId',
        'ExecuteGrant',
        'InteractionGrant',
        'AgentRunRef',
        'targetId',
        'observationId',
        'documentRevision',
        'backendDOMNodeId',
      ]) {
        assert.equal(source.includes(forbidden), false, `${relative} ${forbidden}`);
      }
    }
  });
});
