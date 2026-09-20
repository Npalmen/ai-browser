import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ConversationStore } from '../ai/conversation-store';
import { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import { toAgentRunRef, type AgentRunRef } from '../agent-run/agent-run-types';
import type { SafeAgentLoopOptions, SafeAgentLoopResult } from '../agent-run/safe-agent-loop';
import type { AiAnswerEvent } from '../shared/ai-types';
import type { PreparedActionRecordSnapshot } from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';
import { AgentRunController } from './agent-run-controller';
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
  aborted = false;
  impl: (ref: AgentRunRef, options: SafeAgentLoopOptions) => Promise<SafeAgentLoopResult>;

  constructor(impl?: FakeLoop['impl']) {
    this.impl =
      impl ??
      (async (_ref, options) => {
        this.lastOptions = options;
        options.signal?.addEventListener('abort', () => {
          this.aborted = true;
        });
        return {
          status: 'completed',
          run: {
            runId: 'run-unused',
            tabId: TAB,
            generation: 1,
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
        };
      });
  }

  run(ref: AgentRunRef, options: SafeAgentLoopOptions): Promise<SafeAgentLoopResult> {
    this.runCalls.push(ref);
    this.lastOptions = options;
    options.signal?.addEventListener('abort', () => {
      this.aborted = true;
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

function controllerOf(
  loop: FakeLoop,
  extras: {
    manager?: FakeManager;
    lifecycle?: FakeLifecycle;
    canStartManualAct?: (tabId: TabId) => boolean;
  } = {},
) {
  const events: AiAnswerEvent[] = [];
  const coordinator = new AgentRunCoordinator({
    generateRunId: () => `run-${loop.runCalls.length + 1}`,
  });
  const conversationStore = new ConversationStore();
  const manager = extras.manager ?? new FakeManager();
  const lifecycle = extras.lifecycle ?? new FakeLifecycle();
  const executor = new AgentRunExecutor({
    coordinator,
    loop,
    manager,
    lifecycle,
  });
  const controller = new AgentRunController({
    executor,
    conversationStore,
    emit: (event) => {
      events.push(event);
    },
    canStartManualAct: extras.canStartManualAct,
  });
  return { controller, events, coordinator, conversationStore, manager, lifecycle, loop, executor };
}

function wrappingController(loop: FakeLoop, extras: { manager?: FakeManager; lifecycle?: FakeLifecycle } = {}) {
  const inner = controllerOf(loop, extras);
  const cancelRefs: AgentRunRef[] = [];
  const cancelAndWaitRefs: AgentRunRef[] = [];
  let invalidateCount = 0;
  const controller = new AgentRunController({
    conversationStore: inner.conversationStore,
    emit: (event) => {
      inner.events.push(event);
    },
    executor: {
      start: (tabId, instruction, options) => inner.executor.start(tabId, instruction, options),
      cancel: (ref, reason) => {
        cancelRefs.push(ref);
        return inner.executor.cancel(ref, reason);
      },
      cancelAndWait: async (ref, reason) => {
        cancelAndWaitRefs.push(ref);
        await inner.executor.cancelAndWait(ref, reason);
      },
      invalidatePendingStarts: (tabId) => {
        invalidateCount += 1;
        inner.executor.invalidatePendingStarts(tabId);
      },
      getActiveRef: (tabId) => inner.executor.getActiveRef(tabId),
      isActive: (tabId) => inner.executor.isActive(tabId),
      dispose: () => inner.executor.dispose(),
    },
  });
  return {
    inner,
    controller,
    cancelRefs,
    cancelAndWaitRefs,
    get invalidateCount() {
      return invalidateCount;
    },
  };
}

describe('AgentRunController', () => {
  it('starts an Act run and commits exactly one conversation turn on completion', async () => {
    const harness = controllerOf(new FakeLoop());
    const started = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    const result = await started.completion;
    assert.equal(result.status, 'completed');
    assert.equal(harness.events[0]?.type, 'agent-run-started');
    assert.equal(
      harness.events.some((event) => event.type === 'agent-run-completed'),
      true,
    );
    const stored = harness.conversationStore.get(TAB);
    assert.equal(stored?.turns.length, 1);
    assert.equal(stored?.turns[0]?.question, 'Do the task');
    assert.equal(stored?.turns[0]?.answer, 'Final answer');
    assert.equal(stored?.documentRevision, 'rev-final');
  });

  it('does not commit a conversation turn for cancelled, blocked, failed, or unknown', async () => {
    for (const terminal of [
      { state: 'cancelled', reason: 'USER_CANCELLED' },
      { state: 'blocked', reason: 'POLICY_BLOCKED' },
      { state: 'failed', reason: 'MODEL_FAILED' },
      { state: 'execution-state-unknown', reason: 'EXECUTION_STATE_UNKNOWN' },
    ] as const) {
      const loop = new FakeLoop(async (ref) => ({
        status: 'terminal',
        run: {
          runId: ref.runId,
          tabId: ref.tabId,
          generation: ref.generation,
          instruction: 'x',
          startedAt: 1,
          state: terminal.state,
          modelStepCount: 1,
          actionAttemptCount: 0,
          approvalCount: 0,
          terminalReason: terminal.reason,
        },
      }));
      const harness = controllerOf(loop);
      const started = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
      if (started.status === 'started') {
        await started.completion;
      }
      assert.equal(harness.conversationStore.get(TAB), undefined, terminal.state);
    }
  });

  it('emits a safe model failure message when the run snapshot includes modelErrorCode', async () => {
    const loop = new FakeLoop(async (ref) => ({
      status: 'terminal',
      run: {
        runId: ref.runId,
        tabId: ref.tabId,
        generation: ref.generation,
        instruction: 'x',
        startedAt: 1,
        state: 'failed',
        modelStepCount: 1,
        actionAttemptCount: 0,
        approvalCount: 0,
        terminalReason: 'MODEL_FAILED',
        modelErrorCode: 'MODEL_OUTPUT_INVALID',
      },
    }));
    const harness = controllerOf(loop);
    const started = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    if (started.status === 'started') {
      await started.completion;
    }
    const failed = harness.events.find((event) => event.type === 'agent-run-failed');
    assert.ok(failed);
    if (failed?.type === 'agent-run-failed') {
      assert.equal(failed.reason, 'MODEL_FAILED');
      assert.equal(failed.safeMessage, 'The AI response was invalid.');
    }
  });

  it('stops a running run and aborts the generation', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async (ref, options) => {
      await hold.promise;
      return {
        status: 'terminal',
        run: {
          runId: ref.runId,
          tabId: ref.tabId,
          generation: ref.generation,
          instruction: 'x',
          startedAt: 1,
          state: 'cancelled',
          modelStepCount: 0,
          actionAttemptCount: 0,
          approvalCount: 0,
          terminalReason: 'USER_CANCELLED',
        },
      };
    });
    const harness = controllerOf(loop);
    const started = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    assert.equal(harness.controller.cancel(TAB, 'USER_CANCELLED'), true);
    assert.equal(loop.aborted, true);
    hold.resolve({ status: 'ignored' });
    if (started.status === 'started') {
      await started.completion;
    }
    assert.equal(
      harness.events.some((event) => event.type === 'agent-run-cancelled'),
      true,
    );
  });

  it('stops an awaiting-approval run and invalidates V4 before dispatch', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const lifecycle = new FakeLifecycle();
    const harness = controllerOf(loop, { lifecycle });
    const started = await harness.controller.start(TAB, 'Buy now', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    harness.coordinator.presentApproval(toAgentRunRef(started.run), 'appr-1');
    assert.equal(harness.controller.cancel(TAB, 'USER_CANCELLED'), true);
    assert.equal(loop.aborted, true);
    assert.deepEqual(lifecycle.invalidated, [TAB]);
    hold.resolve({
      status: 'terminal',
      run: {
        ...started.run,
        state: 'cancelled',
        terminalReason: 'USER_CANCELLED',
      },
    });
    await started.completion;
  });

  it('Stop after adapter dispatch does not abort V4 and cancels only after executed', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const manager = new FakeManager();
    const lifecycle = new FakeLifecycle();
    const harness = controllerOf(loop, { manager, lifecycle });
    const started = await harness.controller.start(TAB, 'Buy now', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    harness.coordinator.presentApproval(toAgentRunRef(started.run), 'appr-1');
    manager.snapshot = executingSnapshot(true);
    assert.equal(harness.controller.cancel(TAB, 'USER_CANCELLED'), true);
    assert.equal(loop.aborted, false);
    assert.deepEqual(lifecycle.invalidated, []);
    assert.equal(
      harness.events.some((event) => event.type === 'agent-run-cancelled'),
      false,
    );
    const notified = harness.coordinator.notifyApprovalOutcome('appr-1', 'executed');
    assert.equal(notified.status, 'applied');
    if (notified.status === 'applied') {
      assert.equal(notified.snapshot.state, 'cancelled');
      assert.equal(notified.snapshot.terminalReason, 'USER_CANCELLED');
      hold.resolve({ status: 'terminal', run: notified.snapshot });
    }
    await started.completion;
    assert.equal(
      harness.events.some((event) => event.type === 'agent-run-cancelled'),
      true,
    );
    assert.equal(
      harness.events.some((event) => event.type === 'agent-run-completed'),
      false,
    );
  });

  it('Stop after dispatch keeps unknown over cancellation', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const manager = new FakeManager();
    const harness = controllerOf(loop, { manager });
    const started = await harness.controller.start(TAB, 'Buy now', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    harness.coordinator.presentApproval(toAgentRunRef(started.run), 'appr-1');
    manager.snapshot = executingSnapshot(true);
    harness.controller.cancel(TAB, 'USER_CANCELLED');
    const notified = harness.coordinator.notifyApprovalOutcome(
      'appr-1',
      'execution-state-unknown',
    );
    assert.equal(notified.status, 'applied');
    if (notified.status === 'applied') {
      assert.equal(notified.snapshot.state, 'execution-state-unknown');
      hold.resolve({ status: 'terminal', run: notified.snapshot });
    }
    await started.completion;
    assert.equal(
      harness.events.some((event) => event.type === 'agent-run-execution-state-unknown'),
      true,
    );
    assert.equal(
      harness.events.some((event) => event.type === 'agent-run-cancelled'),
      false,
    );
    assert.equal(harness.conversationStore.get(TAB), undefined);
  });

  it('Stop before adapter dispatch invalidates V4', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const manager = new FakeManager();
    const lifecycle = new FakeLifecycle();
    const harness = controllerOf(loop, { manager, lifecycle });
    const started = await harness.controller.start(TAB, 'Buy now', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    harness.coordinator.presentApproval(toAgentRunRef(started.run), 'appr-1');
    manager.snapshot = executingSnapshot(false);
    harness.controller.cancel(TAB, 'USER_CANCELLED');
    assert.equal(loop.aborted, true);
    assert.deepEqual(lifecycle.invalidated, [TAB]);
    hold.resolve({
      status: 'terminal',
      run: { ...started.run, state: 'cancelled', terminalReason: 'USER_CANCELLED' },
    });
    await started.completion;
  });

  it('same-tab Act supersede cancels the old run then starts the new one', async () => {
    const firstHold = new Deferred<SafeAgentLoopResult>();
    const secondHold = new Deferred<SafeAgentLoopResult>();
    let runs = 0;
    const loop = new FakeLoop(async (ref) => {
      runs += 1;
      const hold = runs === 1 ? firstHold : secondHold;
      await hold.promise;
      return {
        status: 'terminal',
        run: {
          runId: ref.runId,
          tabId: ref.tabId,
          generation: ref.generation,
          instruction: 'x',
          startedAt: 1,
          state: 'cancelled',
          modelStepCount: 0,
          actionAttemptCount: 0,
          approvalCount: 0,
          terminalReason: 'SUPERSEDED',
        },
      };
    });
    const lifecycle = new FakeLifecycle();
    const harness = controllerOf(loop, { lifecycle });
    const first = await harness.controller.start(TAB, 'First', { askId: 'ask-a' });
    const secondPromise = harness.controller.start(TAB, 'Second', { askId: 'ask-b' });
    firstHold.resolve({ status: 'ignored' });
    const second = await secondPromise;
    assert.equal(second.status, 'started');
    if (first.status === 'started' && second.status === 'started') {
      assert.notEqual(first.run.runId, second.run.runId);
    }
    assert.ok(lifecycle.invalidated.includes(TAB));
    secondHold.resolve({ status: 'ignored' });
    if (second.status === 'started') {
      await second.completion;
    }
    assert.equal(
      harness.events.filter((event) => event.type === 'agent-run-started').length,
      2,
    );
  });

  it('serializes a new run behind post-dispatch cancellation', async () => {
    const firstHold = new Deferred<SafeAgentLoopResult>();
    const secondHold = new Deferred<SafeAgentLoopResult>();
    let runs = 0;
    const loop = new FakeLoop(async () => {
      runs += 1;
      return runs === 1 ? firstHold.promise : secondHold.promise;
    });
    const manager = new FakeManager();
    const harness = controllerOf(loop, { manager });
    const first = await harness.controller.start(TAB, 'First', { askId: 'ask-a' });
    assert.equal(first.status, 'started');
    if (first.status !== 'started') {
      throw new Error('expected first');
    }
    harness.coordinator.presentApproval(toAgentRunRef(first.run), 'appr-1');
    manager.snapshot = executingSnapshot(true);
    let secondStarted = false;
    const secondPromise = harness.controller.start(TAB, 'Second', { askId: 'ask-b' }).then((result) => {
      secondStarted = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondStarted, false);
    assert.equal(loop.runCalls.length, 1);
    const notified = harness.coordinator.notifyApprovalOutcome('appr-1', 'executed');
    if (notified.status === 'applied') {
      firstHold.resolve({ status: 'terminal', run: notified.snapshot });
    }
    const second = await secondPromise;
    assert.equal(second.status, 'started');
    assert.equal(loop.runCalls.length, 2);
    secondHold.resolve({ status: 'ignored' });
    if (second.status === 'started') {
      await second.completion;
    }
  });

  it('keeps different tabs independent', async () => {
    const holds = new Map<string, Deferred<SafeAgentLoopResult>>();
    const loop = new FakeLoop(async (ref) => {
      const hold = new Deferred<SafeAgentLoopResult>();
      holds.set(ref.tabId, hold);
      return hold.promise;
    });
    const lifecycle = new FakeLifecycle();
    const harness = controllerOf(loop, { lifecycle });
    const a = await harness.controller.start(TAB, 'A', { askId: 'ask-a' });
    const b = await harness.controller.start(TAB_B, 'B', { askId: 'ask-b' });
    assert.equal(a.status, 'started');
    assert.equal(b.status, 'started');
    harness.controller.cancel(TAB, 'USER_CANCELLED');
    assert.equal(lifecycle.invalidated.includes(TAB_B), false);
    assert.equal(harness.controller.isActive(TAB_B), true);
    holds.get(TAB_B)?.resolve({ status: 'ignored' });
    holds.get(TAB)?.resolve({ status: 'ignored' });
    if (a.status === 'started') {
      await a.completion;
    }
    if (b.status === 'started') {
      await b.completion;
    }
  });

  it('clear, tab close, renderer crash, and chrome navigation terminate the run', async () => {
    for (const action of ['clear', 'tab-close', 'crash', 'chrome'] as const) {
      const hold = new Deferred<SafeAgentLoopResult>();
      const loop = new FakeLoop(async () => hold.promise);
      const harness = controllerOf(loop);
      harness.conversationStore.commitTurn(TAB, 'rev-old', { question: 'old', answer: 'old' });
      const started = await harness.controller.start(TAB, 'Do', { askId: 'ask-1' });
      if (action === 'clear') {
        harness.controller.clearConversation(TAB);
        assert.equal(harness.conversationStore.get(TAB), undefined);
      } else if (action === 'tab-close') {
        harness.controller.handleTabClosed(TAB);
        assert.equal(harness.conversationStore.get(TAB), undefined);
      } else if (action === 'crash') {
        harness.controller.handleRendererCrash(TAB);
        assert.equal(harness.conversationStore.get(TAB), undefined);
      } else {
        harness.controller.cancelForTrustedChromeNavigation(TAB);
        assert.equal(harness.conversationStore.get(TAB)?.turns.length, 1);
      }
      assert.equal(loop.aborted, true);
      hold.resolve({ status: 'ignored' });
      if (started.status === 'started') {
        await started.completion;
      }
    }
  });

  it('drops late events from an old run after a newer run is active', async () => {
    const secondHold = new Deferred<SafeAgentLoopResult>();
    let runs = 0;
    const loop = new FakeLoop(async () => {
      runs += 1;
      if (runs === 1) {
        return { status: 'ignored' };
      }
      return secondHold.promise;
    });
    const harness = controllerOf(loop);
    await harness.controller.start(TAB, 'First', { askId: 'ask-a' });
    const second = await harness.controller.start(TAB, 'Second', { askId: 'ask-b' });
    harness.loop.lastOptions?.onAwaitingApproval?.({
      runId: 'run-1',
      tabId: TAB,
      generation: 1,
      instruction: 'First',
      startedAt: 1,
      state: 'awaiting-approval',
      modelStepCount: 1,
      actionAttemptCount: 1,
      approvalCount: 1,
    });
    assert.equal(
      harness.events.some(
        (event) => event.type === 'agent-run-awaiting-approval' && event.askId === 'ask-a',
      ),
      false,
    );
    secondHold.resolve({ status: 'ignored' });
    if (second.status === 'started') {
      await second.completion;
    }
  });

  it('dispose clears conversation and active runs', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const harness = controllerOf(loop);
    await harness.controller.start(TAB, 'Do', { askId: 'ask-1' });
    harness.conversationStore.commitTurn(TAB, 'rev', { question: 'q', answer: 'a' });
    harness.controller.dispose();
    assert.equal(harness.controller.isActive(TAB), false);
    assert.equal(harness.conversationStore.get(TAB), undefined);
    hold.resolve({ status: 'ignored' });
  });

  it('passes prior conversation history into the executor for manual Act', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const harness = controllerOf(loop);
    harness.conversationStore.commitTurn(TAB, 'rev-old', { question: 'old q', answer: 'old a' });
    const started = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    assert.equal(typeof harness.loop.lastOptions?.priorConversationForRevision, 'function');
    assert.match(
      harness.loop.lastOptions?.priorConversationForRevision?.(TAB, 'rev-old') ?? '',
      /old q/,
    );
    const prior =
      harness.loop.lastOptions?.priorConversationForRevision?.(TAB, 'rev-old') ?? '';
    assert.match(prior, /<PRIOR_USER_CONTEXT>/);
    assert.equal(prior.includes('old a'), false);
    hold.resolve({ status: 'ignored' });
    if (started.status === 'started') {
      await started.completion;
    }
  });

  it('does not commit a child executor run into ConversationStore', async () => {
    const harness = controllerOf(new FakeLoop());
    const child = await harness.executor.start(TAB, 'Child subgoal');
    if (child.status === 'started') {
      await child.completion;
    }
    assert.equal(harness.conversationStore.get(TAB), undefined);
    const manual = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    if (manual.status === 'started') {
      await manual.completion;
    }
    assert.equal(harness.conversationStore.get(TAB)?.turns.length, 1);
    assert.equal(harness.conversationStore.get(TAB)?.turns[0]?.question, 'Do the task');
  });

  it('installs exact product ownership in onStarted before start returns', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const harness = controllerOf(loop);
    const started = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      throw new Error('expected start');
    }
    assert.equal(harness.controller.isActive(TAB), true);
    assert.equal(started.run.runId, harness.executor.getActiveRef(TAB)?.runId);
    assert.equal(harness.controller.cancel(TAB, 'USER_CANCELLED'), true);
    assert.equal(loop.aborted, true);
    hold.resolve({ status: 'ignored' });
    await started.completion;
  });

  it('does not cancel an unowned executor run via cancel', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const harness = wrappingController(loop);
    const child = await harness.inner.executor.start(TAB, 'Child subgoal');
    assert.equal(child.status, 'started');
    if (child.status !== 'started') {
      throw new Error('expected child');
    }
    assert.equal(harness.controller.isActive(TAB), false);
    assert.equal(harness.controller.cancel(TAB, 'USER_CANCELLED'), false);
    assert.equal(harness.cancelRefs.length, 0);
    assert.equal(harness.invalidateCount, 1);
    assert.equal(loop.aborted, false);
    assert.equal(harness.inner.executor.getActiveRef(TAB)?.runId, child.ref.runId);
    hold.resolve({ status: 'ignored' });
    await child.completion;
  });

  it('does not cancel an unowned executor run via cancelActive', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => hold.promise);
    const harness = wrappingController(loop);
    const child = await harness.inner.executor.start(TAB, 'Child subgoal');
    assert.equal(child.status, 'started');
    if (child.status !== 'started') {
      throw new Error('expected child');
    }
    await harness.controller.cancelActive(TAB, 'SUPERSEDED');
    assert.equal(harness.cancelAndWaitRefs.length, 0);
    assert.equal(harness.cancelRefs.length, 0);
    assert.equal(harness.invalidateCount, 1);
    assert.equal(loop.aborted, false);
    assert.equal(harness.inner.executor.getActiveRef(TAB)?.runId, child.ref.runId);
    hold.resolve({ status: 'ignored' });
    await child.completion;
  });

  it('lifecycle methods do not seize an unowned executor run', async () => {
    for (const action of ['clear', 'tab-close', 'crash', 'chrome'] as const) {
      const hold = new Deferred<SafeAgentLoopResult>();
      const loop = new FakeLoop(async () => hold.promise);
      const harness = wrappingController(loop);
      harness.inner.conversationStore.commitTurn(TAB, 'rev-old', { question: 'old', answer: 'old' });
      const child = await harness.inner.executor.start(TAB, 'Child subgoal');
      assert.equal(child.status, 'started');
      if (child.status !== 'started') {
        throw new Error('expected child');
      }
      if (action === 'clear') {
        harness.controller.clearConversation(TAB);
        assert.equal(harness.inner.conversationStore.get(TAB), undefined);
      } else if (action === 'tab-close') {
        harness.controller.handleTabClosed(TAB);
        assert.equal(harness.inner.conversationStore.get(TAB), undefined);
      } else if (action === 'crash') {
        harness.controller.handleRendererCrash(TAB);
        assert.equal(harness.inner.conversationStore.get(TAB), undefined);
      } else {
        harness.controller.cancelForTrustedChromeNavigation(TAB);
        assert.equal(harness.inner.conversationStore.get(TAB)?.turns.length, 1);
      }
      assert.equal(harness.cancelRefs.length, 0, action);
      assert.equal(harness.cancelAndWaitRefs.length, 0, action);
      assert.equal(loop.aborted, false, action);
      assert.equal(harness.inner.executor.getActiveRef(TAB)?.runId, child.ref.runId, action);
      hold.resolve({ status: 'ignored' });
      await child.completion;
    }
  });

  it('invalidates a pending manual start without cancelling via unowned active-ref lookup', async () => {
    const firstHold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => firstHold.promise);
    const manager = new FakeManager();
    const harness = wrappingController(loop, { manager });
    const child = await harness.inner.executor.start(TAB, 'Child subgoal');
    assert.equal(child.status, 'started');
    if (child.status !== 'started') {
      throw new Error('expected child');
    }
    harness.inner.coordinator.presentApproval(child.ref, 'appr-1');
    manager.snapshot = executingSnapshot(true);

    let startResolved = false;
    const pending = harness.controller.start(TAB, 'Manual', { askId: 'ask-1' }).then((result) => {
      startResolved = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(startResolved, false);
    assert.equal(harness.controller.isActive(TAB), false);
    assert.equal(harness.controller.cancel(TAB, 'USER_CANCELLED'), false);
    assert.equal(harness.cancelRefs.length, 0);

    const notified = harness.inner.coordinator.notifyApprovalOutcome('appr-1', 'executed');
    if (notified.status === 'applied') {
      firstHold.resolve({ status: 'terminal', run: notified.snapshot });
    }
    const result = await pending;
    assert.equal(result.status, 'ignored');
    assert.equal(harness.controller.isActive(TAB), false);
  });

  it('cancels an owned manual run through every product lifecycle path', async () => {
    for (const action of ['cancel', 'cancelActive', 'clear', 'tab-close', 'crash', 'chrome'] as const) {
      const hold = new Deferred<SafeAgentLoopResult>();
      const loop = new FakeLoop(async () => hold.promise);
      const harness = wrappingController(loop);
      const started = await harness.controller.start(TAB, 'Do', { askId: 'ask-1' });
      assert.equal(started.status, 'started');
      if (started.status !== 'started') {
        throw new Error('expected start');
      }
      if (action === 'cancel') {
        assert.equal(harness.controller.cancel(TAB, 'USER_CANCELLED'), true);
        assert.equal(harness.cancelRefs[0]?.runId, started.run.runId);
      } else if (action === 'cancelActive') {
        const draining = harness.controller.cancelActive(TAB, 'SUPERSEDED');
        assert.equal(harness.cancelAndWaitRefs[0]?.runId, started.run.runId);
        assert.equal(loop.aborted, true, action);
        hold.resolve({ status: 'ignored' });
        await draining;
        await started.completion;
        continue;
      } else if (action === 'clear') {
        harness.controller.clearConversation(TAB);
        assert.equal(harness.cancelRefs[0]?.runId, started.run.runId);
      } else if (action === 'tab-close') {
        harness.controller.handleTabClosed(TAB);
        assert.equal(harness.cancelRefs[0]?.runId, started.run.runId);
      } else if (action === 'crash') {
        harness.controller.handleRendererCrash(TAB);
        assert.equal(harness.cancelRefs[0]?.runId, started.run.runId);
      } else {
        harness.controller.cancelForTrustedChromeNavigation(TAB);
        assert.equal(harness.cancelRefs[0]?.runId, started.run.runId);
      }
      assert.equal(loop.aborted, true, action);
      hold.resolve({ status: 'ignored' });
      await started.completion;
    }
  });

  it('emits renderer-safe events without authority fields', async () => {
    const harness = controllerOf(new FakeLoop());
    const started = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    if (started.status === 'started') {
      await started.completion;
    }
    const serialized = JSON.stringify(harness.events);
    for (const token of [
      'targetId',
      'observationId',
      'documentRevision',
      'approvalId',
      'preparedActionId',
      'executionId',
      'InteractionGrant',
      'ExecuteGrant',
      'backendNodeId',
      'frameId',
      'proposal',
    ]) {
      assert.equal(serialized.includes(token), false, token);
    }
    assert.equal(serialized.includes('ask-1'), true);
    assert.equal(serialized.includes(TAB), true);
  });

  it('blocks manual Act before AgentRun start when the ownership gate is closed', async () => {
    const loop = new FakeLoop();
    const harness = controllerOf(loop, { canStartManualAct: () => false });
    const started = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    assert.equal(started.status, 'ignored');
    assert.equal(loop.runCalls.length, 0);
    assert.equal(harness.conversationStore.get(TAB), undefined);
  });

  it('allows manual Act on an unowned tab when the ownership gate is open', async () => {
    const owned = new Set<TabId>([TAB]);
    const loop = new FakeLoop();
    const harness = controllerOf(loop, {
      canStartManualAct: (tabId) => !owned.has(tabId),
    });
    const blocked = await harness.controller.start(TAB, 'Do the task', { askId: 'ask-1' });
    assert.equal(blocked.status, 'ignored');
    const allowed = await harness.controller.start(TAB_B, 'Do the task', { askId: 'ask-2' });
    assert.equal(allowed.status, 'started');
    if (allowed.status === 'started') {
      await allowed.completion;
    }
  });

  it('rechecks the ownership gate inside shouldStart after same-tab drain', async () => {
    const firstHold = new Deferred<SafeAgentLoopResult>();
    const loop = new FakeLoop(async () => firstHold.promise);
    const owned = new Set<TabId>();
    const harness = controllerOf(loop, {
      canStartManualAct: (tabId) => !owned.has(tabId),
    });
    const first = await harness.controller.start(TAB, 'First', { askId: 'ask-a' });
    assert.equal(first.status, 'started');
    const secondPromise = harness.controller.start(TAB, 'Second', { askId: 'ask-b' });
    owned.add(TAB);
    firstHold.resolve({ status: 'ignored' });
    const second = await secondPromise;
    assert.equal(second.status, 'ignored');
    assert.equal(loop.runCalls.length, 1);
  });

  it('keeps the same AgentRun active and visible on an adopted popup tab', async () => {
    const hold = new Deferred<SafeAgentLoopResult>();
    const box: { coordinator?: AgentRunCoordinator } = {};
    const loop = new FakeLoop(async (ref, options) => {
      const coordinator = box.coordinator;
      assert.ok(coordinator);
      const adopted = coordinator.adoptCausalPopup(ref, TAB_B);
      assert.equal(adopted.status, 'applied');
      const snapshot = coordinator.getRun(ref.runId);
      assert.ok(snapshot);
      options.onContinuing?.(snapshot);
      return hold.promise;
    });
    const harness = controllerOf(loop);
    box.coordinator = harness.coordinator;
    const started = await harness.controller.start(TAB, 'Open WebDriverIO', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    assert.equal(harness.controller.isActive(TAB), true);
    assert.equal(harness.controller.isActive(TAB_B), true);
    assert.equal(
      harness.events.some(
        (event) => event.type === 'agent-run-progress' && event.tabId === TAB_B,
      ),
      true,
    );
    assert.equal(harness.controller.cancel(TAB_B, 'TAB_CLOSED'), true);
    hold.resolve({ status: 'ignored' });
    if (started.status === 'started') {
      await started.completion;
    }
    assert.equal(harness.controller.isActive(TAB), false);
    assert.equal(harness.controller.isActive(TAB_B), false);
  });

  it('does not alias origin product onto a destination owned by a newer Act', async () => {
    const originHold = new Deferred<SafeAgentLoopResult>();
    const destHold = new Deferred<SafeAgentLoopResult>();
    const box: { coordinator?: AgentRunCoordinator } = {};
    const loop = new FakeLoop(async (ref, options) => {
      if (ref.tabId === TAB) {
        await originHold.promise;
        const coordinator = box.coordinator;
        assert.ok(coordinator);
        const adopted = coordinator.adoptCausalPopup(ref, TAB_B);
        assert.equal(adopted.status, 'applied');
        if (adopted.status === 'applied') {
          options.onContinuing?.(adopted.snapshot);
          return { status: 'terminal', run: adopted.snapshot };
        }
      }
      return destHold.promise;
    });
    const harness = controllerOf(loop);
    box.coordinator = harness.coordinator;
    const origin = await harness.controller.start(TAB, 'Open popup', { askId: 'ask-origin' });
    const dest = await harness.controller.start(TAB_B, 'User dest act', { askId: 'ask-dest' });
    assert.equal(origin.status, 'started');
    assert.equal(dest.status, 'started');
    originHold.resolve({ status: 'ignored' });
    if (origin.status === 'started') {
      await origin.completion;
    }
    assert.equal(harness.controller.isActive(TAB_B), true);
    assert.equal(harness.coordinator.getActiveRunForTab(TAB_B)?.instruction, 'User dest act');
    assert.equal(harness.controller.isActive(TAB), false);
    destHold.resolve({ status: 'ignored' });
    if (dest.status === 'started') {
      await dest.completion;
    }
  });
});

describe('AgentRunController source isolation', () => {
  it('does not own browser primitives, grants, IPC parsing, or renderer state', () => {
    const source = readFileSync(path.join(__dirname, 'agent-run-controller.ts'), 'utf8');
    for (const token of [
      'BrowserAdapter',
      'ExecuteGrant',
      'claimExecuteGrant',
      'ipcMain',
      'AiUiState',
      'executeJavaScript',
      'AgentRunCoordinator',
      'ApprovalManager',
      'ApprovalLifecycle',
    ]) {
      assert.equal(source.includes(token), false, token);
    }
  });
});
