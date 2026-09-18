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

function controllerOf(loop: FakeLoop, extras: { manager?: FakeManager; lifecycle?: FakeLifecycle } = {}) {
  const events: AiAnswerEvent[] = [];
  const coordinator = new AgentRunCoordinator({
    generateRunId: () => `run-${loop.runCalls.length + 1}`,
  });
  const conversationStore = new ConversationStore();
  const manager = extras.manager ?? new FakeManager();
  const lifecycle = extras.lifecycle ?? new FakeLifecycle();
  const controller = new AgentRunController({
    coordinator,
    loop,
    conversationStore,
    manager,
    lifecycle,
    emit: (event) => {
      events.push(event);
    },
  });
  return { controller, events, coordinator, conversationStore, manager, lifecycle, loop };
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
    ]) {
      assert.equal(source.includes(token), false, token);
    }
  });
});
