import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { AgentRunRef, AgentRunSnapshot } from '../agent-run/agent-run-types';
import type { TabId } from '../shared/browser-types';
import {
  AutonomousTaskChildRunExecutor,
  type AutonomousTaskChildRunRequest,
} from './autonomous-task-child-run-executor';
import type {
  AutonomousTaskAgentRunCompletion,
  AutonomousTaskAgentRunExecutionPort,
  AutonomousTaskAgentRunExecutionStartResult,
} from './agent-run-execution-port';
import { InMemoryAutonomousTaskAuditSink } from './autonomous-task-audit';
import { AutonomousTaskCoordinator } from './autonomous-task-coordinator';
import { AutonomousTaskError } from './autonomous-task-errors';
import {
  MAX_AUTONOMOUS_TASK_CHILD_RUNS,
  toAutonomousTaskRef,
  type AutonomousTaskMutationResult,
  type AutonomousTaskRef,
  type AutonomousTaskSnapshot,
} from './autonomous-task-types';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeAgentRunPort implements AutonomousTaskAgentRunExecutionPort {
  readonly starts: Array<{ tabId: TabId; instruction: string; options?: { shouldStart?: () => boolean } }> =
    [];
  readonly createdRefs: AgentRunRef[] = [];
  lastShouldStart: (() => boolean) | undefined;
  impl: FakeAgentRunPort['start'];

  constructor(impl?: FakeAgentRunPort['start']) {
    this.impl =
      impl ??
      (async (tabId, instruction) => {
        const ref: AgentRunRef = {
          runId: `run-${this.starts.length}`,
          tabId,
          generation: this.starts.length,
        };
        this.createdRefs.push(ref);
        return {
          status: 'started' as const,
          run: completedSnapshot(ref, instruction),
          ref,
          completion: Promise.resolve(completedResult(ref, instruction, `answer-${ref.runId}`)),
        };
      });
  }

  async start(
    tabId: TabId,
    instruction: string,
    options?: { readonly shouldStart?: () => boolean },
  ): Promise<AutonomousTaskAgentRunExecutionStartResult> {
    this.lastShouldStart = options?.shouldStart;
    if (options?.shouldStart !== undefined && !options.shouldStart()) {
      return { status: 'ignored' as const };
    }
    this.starts.push({ tabId, instruction, options });
    return this.impl(tabId, instruction, options);
  }

  cancel(): boolean {
    return false;
  }

  async cancelAndWait(): Promise<void> {}
}

function completedSnapshot(ref: AgentRunRef, instruction: string): AgentRunSnapshot {
  return {
    runId: ref.runId,
    tabId: ref.tabId,
    generation: ref.generation,
    instruction,
    startedAt: 1,
    state: 'completed',
    modelStepCount: 1,
    actionAttemptCount: 0,
    approvalCount: 0,
    terminalReason: 'COMPLETED',
  };
}

function completedResult(
  ref: AgentRunRef,
  instruction: string,
  text: string,
): AutonomousTaskAgentRunCompletion {
  return {
    status: 'completed',
    run: completedSnapshot(ref, instruction),
    answer: {
      text,
      referencedTargets: [],
      alias: 'page-standard',
      truncatedContext: false,
      documentRevision: 'rev-1',
    },
  };
}

function terminalResult(
  ref: AgentRunRef,
  instruction: string,
  state: AgentRunSnapshot['state'],
  reason: AgentRunSnapshot['terminalReason'],
): AutonomousTaskAgentRunCompletion {
  return {
    status: 'terminal',
    run: {
      ...completedSnapshot(ref, instruction),
      state,
      terminalReason: reason,
    },
  };
}

interface Harness {
  coordinator: AutonomousTaskCoordinator;
  sink: InMemoryAutonomousTaskAuditSink;
}

function createHarness(): Harness {
  const sink = new InMemoryAutonomousTaskAuditSink();
  return {
    sink,
    coordinator: new AutonomousTaskCoordinator({
      generateTaskId: () => 'task-1',
      auditSink: sink,
    }),
  };
}

function startTask(
  harness: Harness,
  tabId = 'tab-1',
  objective = 'compare these three plans',
): AutonomousTaskSnapshot {
  return harness.coordinator.startTask(tabId, objective);
}

function refOf(snapshot: AutonomousTaskSnapshot): AutonomousTaskRef {
  return toAutonomousTaskRef(snapshot);
}

function requireApplied(result: AutonomousTaskMutationResult): AutonomousTaskSnapshot {
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') {
    throw new Error('expected applied');
  }
  return result.snapshot;
}

function childRequest(
  snapshot: AutonomousTaskSnapshot,
  overrides: Partial<AutonomousTaskChildRunRequest> = {},
): AutonomousTaskChildRunRequest {
  return {
    ref: refOf(snapshot),
    taskTabAlias: 'task-tab-1',
    instruction: 'Compare refundable prices',
    trustedTabStateToken: 'tab-state-a',
    ...overrides,
  };
}

describe('AutonomousTaskChildRunExecutor', () => {
  it('completes a child as an untrusted model-subgoal-result without consuming extra budget', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const port = new FakeAgentRunPort();
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });

    const result = await executor.execute(childRequest(task));
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') {
      assert.equal(result.result.kind, 'model-subgoal-result');
      assert.equal(result.result.taskTabAlias, 'task-tab-1');
      assert.equal(result.snapshot.state, 'planning');
      assert.equal(result.snapshot.childRunCount, 1);
    }
    assert.equal(port.starts.length, 1);
    assert.equal(port.starts[0]?.tabId, 'tab-1');
    assert.equal(port.starts[0]?.options?.shouldStart !== undefined, true);
  });

  it('blocks unknown aliases as TAB_OWNERSHIP_VIOLATION without starting a child AgentRun', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const port = new FakeAgentRunPort();
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });

    const result = await executor.execute(childRequest(task, { taskTabAlias: 'task-tab-99' }));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.snapshot.state, 'blocked');
      assert.equal(result.snapshot.terminalReason, 'TAB_OWNERSHIP_VIOLATION');
      assert.equal(result.snapshot.childRunCount, 0);
    }
    assert.equal(port.starts.length, 0);
  });

  it('blocks an immediate repeated subgoal before child budget or AgentRun start', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const port = new FakeAgentRunPort();
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });
    const request = childRequest(task);
    const first = await executor.execute(request);
    assert.equal(first.status, 'completed');

    const second = await executor.execute(request);
    assert.equal(second.status, 'terminal');
    if (second.status === 'terminal') {
      assert.equal(second.snapshot.terminalReason, 'TASK_NO_PROGRESS');
      assert.equal(second.snapshot.childRunCount, 1);
    }
    assert.equal(port.starts.length, 1);
  });

  it('allows the same instruction when the trusted tab state token changes', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const port = new FakeAgentRunPort();
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });
    await executor.execute(childRequest(task, { trustedTabStateToken: 'state-1' }));
    const second = await executor.execute(
      childRequest(harness.coordinator.getTask(task.taskId)!, { trustedTabStateToken: 'state-2' }),
    );
    assert.equal(second.status, 'completed');
    assert.equal(port.starts.length, 2);
    assert.equal(harness.coordinator.getTask(task.taskId)?.childRunCount, 2);
  });

  it('blocks the fifth child before AgentRun start', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const port = new FakeAgentRunPort();
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });
    let current = task;
    for (let index = 0; index < MAX_AUTONOMOUS_TASK_CHILD_RUNS; index += 1) {
      const result = await executor.execute(
        childRequest(current, { trustedTabStateToken: `state-${index}` }),
      );
      assert.equal(result.status, 'completed');
      current = harness.coordinator.getTask(task.taskId)!;
    }
    const fifth = await executor.execute(
      childRequest(current, { trustedTabStateToken: 'state-5' }),
    );
    assert.equal(fifth.status, 'terminal');
    if (fifth.status === 'terminal') {
      assert.equal(fifth.snapshot.terminalReason, 'TASK_LIMIT_REACHED');
      assert.equal(fifth.snapshot.childRunCount, 4);
    }
    assert.equal(port.starts.length, 4);
  });

  it('rejects a second child while the first is still pending', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const hold = new Deferred<AutonomousTaskAgentRunCompletion>();
    const startedGate = new Deferred<void>();
    const port = new FakeAgentRunPort(async (tabId, instruction) => {
      const ref: AgentRunRef = { runId: 'run-pending', tabId, generation: 1 };
      startedGate.resolve();
      return {
        status: 'started',
        run: completedSnapshot(ref, instruction),
        ref,
        completion: hold.promise,
      };
    });
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });
    const pending = executor.execute(childRequest(task));
    await startedGate.promise;
    await assert.rejects(
      () =>
        executor.execute(
          childRequest(harness.coordinator.getTask(task.taskId)!, {
            trustedTabStateToken: 'other',
          }),
        ),
      (error: unknown) =>
        error instanceof AutonomousTaskError && error.code === 'AUTONOMOUS_TASK_INVALID_TRANSITION',
    );
    assert.equal(port.starts.length, 1);
    hold.resolve(completedResult({ runId: 'run-pending', tabId: 'tab-1', generation: 1 }, 'x', 'done'));
    await pending;
  });

  it('gives each child a fresh AgentRun identity', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const port = new FakeAgentRunPort();
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });
    await executor.execute(childRequest(task, { trustedTabStateToken: 'a' }));
    await executor.execute(
      childRequest(harness.coordinator.getTask(task.taskId)!, { trustedTabStateToken: 'b' }),
    );
    assert.equal(port.createdRefs.length, 2);
    assert.notEqual(port.createdRefs[0]?.runId, port.createdRefs[1]?.runId);
    assert.notEqual(port.createdRefs[0]?.generation, port.createdRefs[1]?.generation);
  });

  it('ignores a late child result after the task generation changes', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const hold = new Deferred<AutonomousTaskAgentRunCompletion>();
    const startedGate = new Deferred<void>();
    const port = new FakeAgentRunPort(async (tabId, instruction) => {
      const ref: AgentRunRef = { runId: 'run-late', tabId, generation: 1 };
      startedGate.resolve();
      return {
        status: 'started',
        run: completedSnapshot(ref, instruction),
        ref,
        completion: hold.promise,
      };
    });
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });
    const gen1 = refOf(task);
    const pending = executor.execute(childRequest(task));
    await startedGate.promise;
    requireApplied(harness.coordinator.pauseAtSafeBoundary(gen1));
    requireApplied(harness.coordinator.resumeTask(gen1));
    hold.resolve(completedResult({ runId: 'run-late', tabId: 'tab-1', generation: 1 }, 'x', 'stale'));
    const result = await pending;
    assert.deepEqual(result, { status: 'ignored' });
    const current = harness.coordinator.getTask(task.taskId);
    assert.equal(current?.generation, 2);
    assert.equal(current?.state, 'planning');
    assert.equal(current?.lastCompletedSubgoalFingerprint, undefined);
    assert.equal(current?.childRunCount, 1);
  });

  it('maps blocked, failed, unknown, and cancelled child outcomes', async () => {
    const cases: Array<{
      completion: AutonomousTaskAgentRunCompletion;
      state: AutonomousTaskSnapshot['state'];
      reason: AutonomousTaskSnapshot['terminalReason'];
    }> = [
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'blocked',
          'POLICY_BLOCKED',
        ),
        state: 'blocked',
        reason: 'POLICY_BLOCKED',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'blocked',
          'UNSUPPORTED_ACTION',
        ),
        state: 'blocked',
        reason: 'POLICY_BLOCKED',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'blocked',
          'ACTION_STALE',
        ),
        state: 'blocked',
        reason: 'ACTION_STALE',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'blocked',
          'APPROVAL_REJECTED',
        ),
        state: 'blocked',
        reason: 'APPROVAL_REJECTED',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'blocked',
          'APPROVAL_EXPIRED',
        ),
        state: 'blocked',
        reason: 'APPROVAL_EXPIRED',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'blocked',
          'AGENT_LOOP_NO_PROGRESS',
        ),
        state: 'blocked',
        reason: 'TASK_NO_PROGRESS',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'blocked',
          'STEP_LIMIT_REACHED',
        ),
        state: 'blocked',
        reason: 'TASK_LIMIT_REACHED',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'failed',
          'MODEL_FAILED',
        ),
        state: 'failed',
        reason: 'CHILD_RUN_FAILED',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'execution-state-unknown',
          'EXECUTION_STATE_UNKNOWN',
        ),
        state: 'execution-state-unknown',
        reason: 'EXECUTION_STATE_UNKNOWN',
      },
      {
        completion: terminalResult(
          { runId: 'r1', tabId: 'tab-1', generation: 1 },
          'x',
          'cancelled',
          'USER_CANCELLED',
        ),
        state: 'failed',
        reason: 'CHILD_RUN_FAILED',
      },
    ];

    for (const testCase of cases) {
      const harness = createHarness();
      const task = startTask(harness);
      const port = new FakeAgentRunPort(async (tabId, instruction) => {
        const ref: AgentRunRef = { runId: 'r1', tabId, generation: 1 };
        return {
          status: 'started',
          run: completedSnapshot(ref, instruction),
          ref,
          completion: Promise.resolve(testCase.completion),
        };
      });
      const executor = new AutonomousTaskChildRunExecutor({
        coordinator: harness.coordinator,
        agentRuns: port,
      });
      const result = await executor.execute(childRequest(task));
      assert.equal(result.status, 'terminal', testCase.reason);
      if (result.status === 'terminal') {
        assert.equal(result.snapshot.state, testCase.state, String(testCase.reason));
        assert.equal(result.snapshot.terminalReason, testCase.reason);
      }
    }
  });

  it('fails the current task when an expected child start is ignored', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const port = new FakeAgentRunPort(async () => ({ status: 'ignored' }));
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });
    const result = await executor.execute(childRequest(task));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.snapshot.state, 'failed');
      assert.equal(result.snapshot.terminalReason, 'CHILD_RUN_FAILED');
    }
  });

  it('does not pass prior conversation or product callbacks to the AgentRun port', async () => {
    const harness = createHarness();
    const task = startTask(harness);
    const port = new FakeAgentRunPort();
    const executor = new AutonomousTaskChildRunExecutor({
      coordinator: harness.coordinator,
      agentRuns: port,
    });
    await executor.execute(childRequest(task));
    const options = port.starts[0]?.options ?? {};
    assert.deepEqual(Object.keys(options), ['shouldStart']);
  });
});

describe('AutonomousTaskChildRunExecutor source isolation', () => {
  it('does not import ConversationStore, V4, BrowserAdapter, Electron, React, or IPC', () => {
    const files = [
      'autonomous-task-child-run-executor.ts',
      'agent-run-execution-port.ts',
    ];
    const forbidden = [
      'ConversationStore',
      'ApprovalManager',
      'ApprovalLifecycle',
      'BrowserAdapter',
      'ElectronBrowserAdapter',
      'ipcMain',
      "from 'electron'",
      'from "electron"',
      "from 'react'",
      'from "react"',
      'AgentRunExecutor',
    ];
    for (const file of files) {
      const source = readFileSync(path.join(__dirname, file), 'utf8');
      for (const needle of forbidden) {
        assert.equal(source.includes(needle), false, `${file} contains ${needle}`);
      }
    }
  });
});
