import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import { toAgentRunRef, type AgentRunRef } from '../agent-run/agent-run-types';
import type { SafeAgentLoopOptions, SafeAgentLoopResult } from '../agent-run/safe-agent-loop';
import type { PreparedActionRecordSnapshot } from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';
import { AgentRunExecutor } from './agent-run-executor';

const TAB: TabId = 'tab-1';
const TAB_B: TabId = 'tab-2';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeLoop {
  readonly runCalls: AgentRunRef[] = [];
  lastOptions: SafeAgentLoopOptions | undefined;
  abortedByRunId = new Map<string, boolean>();
  impl: (ref: AgentRunRef, options: SafeAgentLoopOptions) => Promise<SafeAgentLoopResult>;

  constructor(impl?: FakeLoop['impl']) {
    this.impl =
      impl ??
      (async (ref) => ({
        status: 'completed',
        run: {
          runId: ref.runId,
          tabId: ref.tabId,
          generation: ref.generation,
          instruction: 'x',
          startedAt: 1,
          state: 'completed',
          modelStepCount: 1,
          actionAttemptCount: 0,
          approvalCount: 0,
          terminalReason: 'COMPLETED',
        },
        answer: {
          text: 'Final answer',
          referencedTargets: [],
          alias: 'page-standard',
          truncatedContext: false,
          documentRevision: 'rev-final',
        },
      }));
  }

  run(ref: AgentRunRef, options: SafeAgentLoopOptions): Promise<SafeAgentLoopResult> {
    this.runCalls.push(ref);
    this.lastOptions = options;
    options.signal?.addEventListener('abort', () => {
      this.abortedByRunId.set(ref.runId, true);
    });
    return this.impl(ref, options);
  }
}

class FakeManager {
  snapshot: PreparedActionRecordSnapshot | undefined;

  getSnapshot(): PreparedActionRecordSnapshot | undefined {
    return this.snapshot;
  }
}

class FakeLifecycle {
  readonly invalidated: TabId[] = [];

  invalidateTab(tabId: TabId): void {
    this.invalidated.push(tabId);
  }
}

function executingSnapshot(invoked: boolean): PreparedActionRecordSnapshot {
  return {
    action: {
      preparedActionId: 'prep-1',
      approvalId: 'appr-1',
      kind: 'click',
      tabId: TAB,
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
      adapterPrimitiveInvoked: invoked,
      postObservationSucceeded: false,
    },
  };
}

function executorOf(loop: FakeLoop, extras: { manager?: FakeManager; lifecycle?: FakeLifecycle } = {}) {
  const coordinator = new AgentRunCoordinator({
    generateRunId: () => `run-${loop.runCalls.length + 1}`,
  });
  const manager = extras.manager ?? new FakeManager();
  const lifecycle = extras.lifecycle ?? new FakeLifecycle();
  const executor = new AgentRunExecutor({
    coordinator,
    loop,
    manager,
    lifecycle,
  });
  return { executor, coordinator, manager, lifecycle, loop };
}

describe('AgentRunExecutor', () => {
  it('starts one AgentRun without conversation or renderer callbacks by default', async () => {
    const harness = executorOf(new FakeLoop());
    const started = await harness.executor.start(TAB, 'Do the task');
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    const result = await started.completion;
    assert.equal(result.status, 'completed');
    assert.equal(harness.loop.lastOptions?.priorConversationForRevision, undefined);
    assert.equal(harness.loop.lastOptions?.onAnswerTextDelta, undefined);
  });

  it('serializes same-tab starts and supersedes the old exact run', async () => {
    const firstHold = new Deferred<SafeAgentLoopResult>();
    const secondHold = new Deferred<SafeAgentLoopResult>();
    let runs = 0;
    const loop = new FakeLoop(async () => {
      runs += 1;
      return runs === 1 ? firstHold.promise : secondHold.promise;
    });
    const lifecycle = new FakeLifecycle();
    const harness = executorOf(loop, { lifecycle });
    const first = await harness.executor.start(TAB, 'First');
    const secondPromise = harness.executor.start(TAB, 'Second');
    firstHold.resolve({ status: 'ignored' });
    const second = await secondPromise;
    assert.equal(second.status, 'started');
    if (first.status === 'started' && second.status === 'started') {
      assert.notEqual(first.run.runId, second.run.runId);
      assert.notEqual(first.run.generation, second.run.generation);
    }
    assert.ok(lifecycle.invalidated.includes(TAB));
    secondHold.resolve({ status: 'ignored' });
    if (second.status === 'started') {
      await second.completion;
    }
  });

  it('does not start when shouldStart returns false after draining the previous run', async () => {
    const firstHold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => firstHold.promise);
    const harness = executorOf(loop);
    const first = await harness.executor.start(TAB, 'First');
    assert.equal(first.status, 'started');
    let allowed = true;
    const secondPromise = harness.executor.start(TAB, 'Second', {
      shouldStart: () => allowed,
    });
    allowed = false;
    firstHold.resolve({ status: 'ignored' });
    const second = await secondPromise;
    assert.equal(second.status, 'ignored');
    assert.equal(loop.runCalls.length, 1);
  });

  it('keeps overlapping start tickets so only the newest start may create a run', async () => {
    const firstHold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => firstHold.promise);
    const manager = new FakeManager();
    const harness = executorOf(loop, { manager });
    const first = await harness.executor.start(TAB, 'First');
    if (first.status !== 'started') {
      throw new Error('expected first');
    }
    harness.coordinator.presentApproval(toAgentRunRef(first.run), 'appr-1');
    manager.snapshot = executingSnapshot(true);
    const stalePromise = harness.executor.start(TAB, 'Stale');
    const newestPromise = harness.executor.start(TAB, 'Newest');
    const notified = harness.coordinator.notifyApprovalOutcome('appr-1', 'executed');
    if (notified.status === 'applied') {
      firstHold.resolve({ status: 'terminal', run: notified.snapshot });
    }
    const stale = await stalePromise;
    const newest = await newestPromise;
    assert.equal(stale.status, 'ignored');
    assert.equal(newest.status, 'started');
    assert.equal(loop.runCalls.length, 2);
    if (newest.status === 'started') {
      await newest.completion.catch(() => undefined);
    }
  });

  it('cancels a pre-dispatch run by exact ref, aborting the signal and invalidating V4', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const lifecycle = new FakeLifecycle();
    const harness = executorOf(loop, { lifecycle });
    const started = await harness.executor.start(TAB, 'Buy now');
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    harness.coordinator.presentApproval(started.ref, 'appr-1');
    assert.equal(harness.executor.cancel(started.ref, 'USER_CANCELLED'), true);
    assert.equal(loop.abortedByRunId.get(started.ref.runId), true);
    assert.deepEqual(lifecycle.invalidated, [TAB]);
    hold.resolve({
      status: 'terminal',
      run: { ...started.run, state: 'cancelled', terminalReason: 'USER_CANCELLED' },
    });
    await started.completion;
  });

  it('requests post-dispatch cancellation without aborting or invalidating', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const manager = new FakeManager();
    const lifecycle = new FakeLifecycle();
    const harness = executorOf(loop, { manager, lifecycle });
    const started = await harness.executor.start(TAB, 'Buy now');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    harness.coordinator.presentApproval(started.ref, 'appr-1');
    manager.snapshot = executingSnapshot(true);
    assert.equal(harness.executor.cancel(started.ref, 'USER_CANCELLED'), true);
    assert.equal(loop.abortedByRunId.get(started.ref.runId), undefined);
    assert.deepEqual(lifecycle.invalidated, []);
    const notified = harness.coordinator.notifyApprovalOutcome('appr-1', 'executed');
    assert.equal(notified.status, 'applied');
    if (notified.status === 'applied') {
      assert.equal(notified.snapshot.state, 'cancelled');
      hold.resolve({ status: 'terminal', run: notified.snapshot });
    }
    await started.completion;
  });

  it('does not let a stale ref cancel a newer same-tab run', async () => {
    const secondHold = new Deferred<SafeAgentLoopResult>();
    let runs = 0;
    const loop = new FakeLoop(async () => {
      runs += 1;
      if (runs === 1) {
        return { status: 'ignored' };
      }
      return secondHold.promise;
    });
    const lifecycle = new FakeLifecycle();
    const harness = executorOf(loop, { lifecycle });
    const first = await harness.executor.start(TAB, 'First');
    const second = await harness.executor.start(TAB, 'Second');
    assert.equal(second.status, 'started');
    if (first.status !== 'started' || second.status !== 'started') {
      throw new Error('expected both starts');
    }
    lifecycle.invalidated.length = 0;
    assert.equal(harness.executor.cancel(first.ref, 'USER_CANCELLED'), false);
    assert.equal(loop.abortedByRunId.get(second.ref.runId), undefined);
    assert.deepEqual(lifecycle.invalidated, []);
    assert.equal(harness.executor.isActive(TAB), true);
    assert.equal(harness.executor.getActiveRef(TAB)?.runId, second.ref.runId);
    secondHold.resolve({ status: 'ignored' });
    await second.completion;
  });

  it('does not let a late completion remove a newer run', async () => {
    const firstHold = new Deferred<SafeAgentLoopResult>();
    const secondHold = new Deferred<SafeAgentLoopResult>();
    let runs = 0;
    const loop = new FakeLoop(async () => {
      runs += 1;
      return runs === 1 ? firstHold.promise : secondHold.promise;
    });
    const harness = executorOf(loop);
    const first = await harness.executor.start(TAB, 'First');
    const secondPromise = harness.executor.start(TAB, 'Second');
    firstHold.resolve({ status: 'ignored' });
    const second = await secondPromise;
    assert.equal(second.status, 'started');
    if (second.status !== 'started') {
      throw new Error('expected second');
    }
    assert.equal(harness.executor.getActiveRef(TAB)?.runId, second.ref.runId);
    secondHold.resolve({ status: 'ignored' });
    await second.completion;
    if (first.status === 'started') {
      await first.completion;
    }
    assert.equal(harness.executor.isActive(TAB), false);
  });

  it('keeps different tabs independent', async () => {
    const holds = new Map<string, Deferred<SafeAgentLoopResult>>();
    const loop = new FakeLoop(async (ref) => {
      const hold = new Deferred<SafeAgentLoopResult>();
      holds.set(ref.tabId, hold);
      return hold.promise;
    });
    const lifecycle = new FakeLifecycle();
    const harness = executorOf(loop, { lifecycle });
    const a = await harness.executor.start(TAB, 'A');
    const b = await harness.executor.start(TAB_B, 'B');
    assert.equal(a.status, 'started');
    assert.equal(b.status, 'started');
    if (a.status === 'started') {
      harness.executor.cancel(a.ref, 'USER_CANCELLED');
    }
    assert.equal(lifecycle.invalidated.includes(TAB_B), false);
    assert.equal(harness.executor.isActive(TAB_B), true);
    holds.get(TAB_B)?.resolve({ status: 'ignored' });
    holds.get(TAB)?.resolve({ status: 'ignored' });
    if (a.status === 'started') {
      await a.completion;
    }
    if (b.status === 'started') {
      await b.completion;
    }
  });

  it('dispose prevents new starts and clears the coordinator using sync V5 semantics', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const harness = executorOf(loop);
    await harness.executor.start(TAB, 'Do');
    harness.executor.dispose();
    assert.equal(harness.executor.isActive(TAB), false);
    const ignored = await harness.executor.start(TAB, 'Again');
    assert.equal(ignored.status, 'ignored');
    assert.equal(harness.coordinator.getActiveRunForTab(TAB), undefined);
    hold.resolve({ status: 'ignored' });
  });

  it('cancels the unique run from an adopted destination tab', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const lifecycle = new FakeLifecycle();
    const harness = executorOf(loop, { lifecycle });
    const started = await harness.executor.start(TAB, 'Do');
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected started');
    }
    const adopted = harness.coordinator.adoptCausalPopup(started.ref, TAB_B);
    assert.equal(adopted.status, 'applied');
    assert.equal(harness.executor.isActive(TAB_B), true);
    assert.equal(harness.executor.getActiveRef(TAB_B)?.runId, started.ref.runId);
    harness.executor.cancel(started.ref, 'TAB_CLOSED');
    assert.equal(lifecycle.invalidated.includes(TAB), true);
    assert.equal(lifecycle.invalidated.includes(TAB_B), true);
    hold.resolve({ status: 'ignored' });
    await started.completion;
    assert.equal(harness.executor.isActive(TAB), false);
    assert.equal(harness.executor.isActive(TAB_B), false);
  });
});

describe('AgentRunExecutor source isolation', () => {
  it('does not import ConversationStore, renderer events, or AutonomousTask', () => {
    const source = readFileSync(path.join(__dirname, 'agent-run-executor.ts'), 'utf8');
    for (const token of [
      'ConversationStore',
      'commitTurn',
      'AiAnswerEvent',
      'agent-run-started',
      'AutonomousTaskCoordinator',
      'React',
      'ipcMain',
    ]) {
      assert.equal(source.includes(token), false, token);
    }
  });
});
