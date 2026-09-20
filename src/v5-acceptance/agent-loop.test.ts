import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_AGENT_LOOP_APPROVALS,
  MAX_AGENT_LOOP_MODEL_STEPS,
  MAX_AGENT_LOOP_SEMANTIC_ACTIONS,
  toAgentRunRef,
} from '../agent-run/agent-run-types';
import { TargetRegistry } from '../observation/target-registry';
import { InteractionError } from '../shared/interaction-errors';
import { trustedCannotCompleteCopy } from '../ai/interaction-output-schema';
import {
  answerRuntime,
  buyNowPage,
  multiStepPage,
  clickRuntime,
  createExecuteFakeAdapter,
  createV5ProductChain,
  lastPendingApproval,
  namedButtonPage,
  node,
  observation,
  seedRegistry,
  startActDirect,
  stepScriptRuntime,
  waitUntil,
} from './chain-helpers';
import { V5AcceptanceModelRuntime } from './recording-agent-model-runtime';
import { V5_TAB_A, V5_TAB_B } from './fixture-constants';

function safePage(name: string, targetId: string, revision = 'rev-safe'): ReturnType<typeof observation> {
  return namedButtonPage(name, targetId, {}, {
    document: {
      revision,
      url: 'http://127.0.0.1/agent-run/two-safe.html',
      title: 'V5 fixture',
      loading: false,
      mainFrameId: 'frame-1',
    },
  });
}

describe('V5 agent loop acceptance', () => {
  it('continues after agent-caused navigation with a fresh page observation', async () => {
    const pageA = observation(
      [
        node({
          role: 'link',
          tag: 'a',
          targetId: 'target-next',
          name: 'Next',
          attributes: { href: 'safe-navigation-b.html' },
        }),
      ],
      {
        tabId: V5_TAB_A,
        observationId: 'obs-nav-a',
        document: {
          revision: 'rev-nav-a',
          url: 'http://127.0.0.1/agent-run/safe-navigation-a.html',
          title: 'Page A',
          loading: false,
          mainFrameId: 'frame-1',
        },
      },
    );
    const pageB = safePage('Safe control B', 'target-b', 'rev-nav-b');
    const registry = new TargetRegistry();
    seedRegistry(registry, pageA);
    const { adapter, counts } = createExecuteFakeAdapter({
      observePage: async () => {
        const page = counts.observePage <= 1 ? pageA : pageB;
        seedRegistry(registry, page, 501);
        return page;
      },
    });
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: stepScriptRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-next' } }),
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-b' } }),
        () => ({
          kind: 'answer',
          disposition: 'cannot-complete',
          cannotCompleteReason: 'completion-not-verifiable',
          text: 'Navigation done.',
          referencedTargets: [],
        }),
      ]),
      observation: [pageA, pageB],
    });
    const result = await startActDirect(chain, V5_TAB_A, 'Navigate then act');
    assert.equal(result.status, 'completed');
    assert.equal(counts.click, 2);
  });

  it('completes two safe actions then a final answer with one durable turn', async () => {
    const page = observation(
      [
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-a',
          name: 'Safe control A',
          attributes: { type: 'button' },
        }),
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-b',
          name: 'Safe control B',
          attributes: { type: 'button' },
        }),
      ],
      {
        tabId: V5_TAB_A,
        observationId: 'obs-two-safe',
        document: {
          revision: 'rev-two-safe',
          url: 'http://127.0.0.1/agent-run/two-safe.html',
          title: 'V5 fixture',
          loading: false,
          mainFrameId: 'frame-1',
        },
      },
    );
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter({
      observePage: async () => page,
    });
    const runtime = stepScriptRuntime([
      () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-a' } }),
      () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-b' } }),
      () => ({
          kind: 'answer',
          disposition: 'cannot-complete',
          cannotCompleteReason: 'completion-not-verifiable',
          text: 'Task complete.',
          referencedTargets: [],
        }),
    ]);
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });
    const result = await startActDirect(chain, V5_TAB_A, 'Do two safe actions');
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') {
      assert.equal(result.run.modelStepCount, 3);
      assert.equal(result.run.actionAttemptCount, 2);
      assert.equal(result.run.approvalCount, 0);
      assert.equal(result.answer.text, trustedCannotCompleteCopy('completion-not-verifiable'));
    }
    assert.equal(counts.click, 2);
    const stored = chain.conversationStore.get(V5_TAB_A);
    assert.equal(stored?.turns.length, 1);
    assert.equal(stored?.turns[0]?.question, 'Do two safe actions');
    assert.equal(stored?.turns[0]?.answer, trustedCannotCompleteCopy('completion-not-verifiable'));
  });

  it('rejects consequential approval and blocks the run without execution', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: stepScriptRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
        () => ({ kind: 'answer', text: 'unused', referencedTargets: [] }),
      ]),
      observation: page,
    });
    const started = await chain.agentRunController.start(V5_TAB_A, 'Buy now', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    await waitUntil(() => chain.aiEvents.some((e) => e.type === 'agent-run-awaiting-approval'));
    const pending = lastPendingApproval(chain);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'pending');
    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'reject' });
    const snapshot = chain.manager.getSnapshot(pending.approvalId);
    assert.equal(snapshot?.action.state, 'rejected');
    assert.equal(counts.click, 0);
    if (started.status === 'started') {
      const result = await started.completion;
      assert.equal(result.status, 'terminal');
      if (result.status === 'terminal') {
        assert.equal(result.run.state, 'blocked');
        assert.equal(result.run.terminalReason, 'APPROVAL_REJECTED');
      }
    }
    assert.equal(chain.conversationStore.get(V5_TAB_A), undefined);
  });

  it('expires approval at TTL and blocks the run', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });
    const started = await chain.agentRunController.start(V5_TAB_A, 'Buy now', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    await waitUntil(() => chain.aiEvents.some((e) => e.type === 'agent-run-awaiting-approval'));
    const pending = lastPendingApproval(chain);
    const expiresAt = chain.manager.getSnapshot(pending.approvalId)?.action.expiresAt;
    assert.ok(expiresAt);
    chain.clock.now = expiresAt;
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(decided.ok, false);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'expired');
    assert.equal(counts.click, 0);
    if (started.status === 'started') {
      const result = await started.completion;
      assert.equal(result.status, 'terminal');
      if (result.status === 'terminal') {
        assert.equal(result.run.terminalReason, 'APPROVAL_EXPIRED');
      }
    }
  });

  it('does not execute a V3 DENY click and stops without approval', async () => {
    const page = observation(
      [
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-deny',
          name: 'Continue',
        }),
      ],
      {
        tabId: V5_TAB_A,
        observationId: 'obs-deny',
        document: {
          revision: 'rev-deny',
          url: 'http://127.0.0.1/interaction/policy-deny.html',
          title: 'Deny fixture',
          loading: false,
          mainFrameId: 'frame-1',
        },
      },
    );
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Continue'),
      observation: page,
    });
    const result = await startActDirect(chain, V5_TAB_A, 'Click denied');
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.state, 'blocked');
      assert.equal(result.run.terminalReason, 'AGENT_LOOP_NO_PROGRESS');
    }
    assert.equal(counts.click, 0);
    assert.equal(chain.approvalEvents.some((e) => e.type === 'approval-required'), false);
  });

  it('blocks repeated identical safe proposals as no-progress', async () => {
    const page = safePage('Repeat safe', 'target-repeat');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter({ observePage: async () => page });
    const runtime = stepScriptRuntime([
      () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-repeat' } }),
      () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-repeat' } }),
    ]);
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });
    const result = await startActDirect(chain, V5_TAB_A, 'Repeat');
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'AGENT_LOOP_NO_PROGRESS');
      assert.equal(result.run.actionAttemptCount, 1);
    }
    assert.equal(counts.click, 1);
  });

  it('blocks the seventh action attempt at STEP_LIMIT_REACHED', async () => {
    const pages = Array.from({ length: 7 }, (_, index) =>
      safePage('Safe control A', `target-${index}`, `rev-${index}`),
    );
    const registry = new TargetRegistry();
    seedRegistry(registry, pages[0]);
    const { adapter, counts } = createExecuteFakeAdapter({
      observePage: async () => pages[Math.min(counts.observePage, pages.length - 1)] ?? pages[0],
    });
    const steps = pages.map((page, index) => () => ({
      kind: 'interaction' as const,
      proposal: { kind: 'click' as const, targetId: `target-${index}` },
    }));
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: stepScriptRuntime(steps),
      observation: pages,
    });
    const result = await startActDirect(chain, V5_TAB_A, 'Many actions');
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'STEP_LIMIT_REACHED');
      assert.equal(result.run.actionAttemptCount, MAX_AGENT_LOOP_SEMANTIC_ACTIONS);
    }
    assert.equal(counts.click, MAX_AGENT_LOOP_SEMANTIC_ACTIONS);
  });

  it('blocks the ninth model step at STEP_LIMIT_REACHED', async () => {
    const page = safePage('Safe control A', 'target-a');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter } = createExecuteFakeAdapter({ observePage: async () => page });
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: answerRuntime('late'),
      observation: page,
    });
    const snapshot = chain.agentRunCoordinator.startRun(V5_TAB_A, 'Many steps');
    const ref = toAgentRunRef(snapshot);
    for (let index = 0; index < MAX_AGENT_LOOP_MODEL_STEPS; index += 1) {
      chain.agentRunCoordinator.recordModelStepCompleted(ref);
    }
    const result = await chain.safeAgentLoop.run(ref);
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'STEP_LIMIT_REACHED');
      assert.equal(result.run.modelStepCount, MAX_AGENT_LOOP_MODEL_STEPS);
    }
  });

  it('blocks a third approval before prepareAndPresent', async () => {
    const page = multiStepPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter({ observePage: async () => page });
    const runtime = stepScriptRuntime([
      () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
      () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-publish' } }),
      () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
      () => ({ kind: 'answer', text: 'done', referencedTargets: [] }),
    ]);
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });
    const started = await chain.agentRunController.start(V5_TAB_A, 'Three buys', {
      askId: 'ask-1',
    });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') {
      return;
    }
    for (let i = 0; i < MAX_AGENT_LOOP_APPROVALS; i += 1) {
      await waitUntil(() =>
        chain.approvalEvents.filter((e) => e.type === 'approval-required').length > i,
      );
      const pending = lastPendingApproval(chain);
      await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
      await waitUntil(
        () => chain.manager.getSnapshot(pending.approvalId)?.action.state === 'executed',
      );
    }
    const result = await started.completion;
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'STEP_LIMIT_REACHED');
      assert.equal(result.run.approvalCount, MAX_AGENT_LOOP_APPROVALS);
    }
    assert.equal(
      chain.approvalEvents.filter((e) => e.type === 'approval-required').length,
      MAX_AGENT_LOOP_APPROVALS,
    );
    assert.equal(counts.click, MAX_AGENT_LOOP_APPROVALS);
  });

  it('cancels while awaiting approval and prevents later execution', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });
    const started = await chain.agentRunController.start(V5_TAB_A, 'Buy now', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    await waitUntil(() => chain.aiEvents.some((e) => e.type === 'agent-run-awaiting-approval'));
    const pending = lastPendingApproval(chain);
    chain.agentRunController.cancel(V5_TAB_A, 'USER_CANCELLED');
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(decided.ok, false);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'stale');
    assert.equal(counts.click, 0);
    if (started.status === 'started') {
      const result = await started.completion;
      assert.equal(result.status, 'terminal');
      if (result.status === 'terminal') {
        assert.equal(result.run.state, 'cancelled');
      }
    }
  });

  it('supersedes same-tab run and ignores late model results', async () => {
    const page = safePage('Safe control A', 'target-a');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    let resolveFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const runtime = new V5AcceptanceModelRuntime(async () => {
      calls += 1;
      if (calls === 1) {
        await firstHold;
      }
      return { kind: 'answer', text: 'late-A', referencedTargets: [] };
    });
    const { adapter } = createExecuteFakeAdapter({ observePage: async () => page });
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });
    const first = await chain.agentRunController.start(V5_TAB_A, 'First', { askId: 'ask-a' });
    const second = await chain.agentRunController.start(V5_TAB_A, 'Second', {
      askId: 'ask-b',
    });
    resolveFirst();
    if (first.status === 'started') {
      const firstResult = await first.completion;
      assert.equal(firstResult.status, 'ignored');
    }
    if (second.status === 'started') {
      second.completion.then(() => undefined);
    }
    assert.equal(
      chain.aiEvents.some(
        (e) => e.type === 'agent-run-completed' && e.askId === 'ask-a',
      ),
      false,
    );
  });

  it('keeps different tabs independent', async () => {
    const page = safePage('Safe control A', 'target-a');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter } = createExecuteFakeAdapter({ observePage: async () => page });
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: answerRuntime('done'),
      observation: page,
    });
    const a = await chain.agentRunController.start(V5_TAB_A, 'A', { askId: 'ask-a' });
    const b = await chain.agentRunController.start(V5_TAB_B, 'B', { askId: 'ask-b' });
    chain.agentRunController.cancel(V5_TAB_A, 'USER_CANCELLED');
    assert.equal(chain.agentRunController.isActive(V5_TAB_B), true);
    if (a.status === 'started') {
      await a.completion;
    }
    if (b.status === 'started') {
      await b.completion;
    }
  });

  it('routes Ask mode through ReadOnlyAgent without creating AgentRun', async () => {
    const page = safePage('Safe control A', 'target-a');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter } = createExecuteFakeAdapter({ observePage: async () => page });
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: answerRuntime('read answer'),
      observation: page,
    });
    chain.aiController.startAsk(V5_TAB_A, 'What is this?', 'read');
    await waitUntil(() => chain.aiEvents.some((e) => e.type === 'answer-finished'));
    assert.equal(chain.aiEvents.some((e) => e.type === 'agent-run-started'), false);
    assert.equal(chain.agentRunController.isActive(V5_TAB_A), false);
  });

  it('does not commit conversation turns for blocked cancelled failed or unknown', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter } = createExecuteFakeAdapter({ observePage: async () => page });

    const blockedChain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });
    const blockedStart = await blockedChain.agentRunController.start(V5_TAB_A, 'Buy', {
      askId: 'blocked',
    });
    await waitUntil(() =>
      blockedChain.aiEvents.some((e) => e.type === 'agent-run-awaiting-approval'),
    );
    await blockedChain.workflow.decide({
      approvalId: lastPendingApproval(blockedChain).approvalId,
      decision: 'reject',
    });
    if (blockedStart.status === 'started') {
      await blockedStart.completion;
    }
    assert.equal(blockedChain.conversationStore.get(V5_TAB_A), undefined);

    const cancelledChain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });
    const cancelledStart = await cancelledChain.agentRunController.start(V5_TAB_A, 'Buy', {
      askId: 'cancelled',
    });
    cancelledChain.agentRunController.cancel(V5_TAB_A);
    if (cancelledStart.status === 'started') {
      await cancelledStart.completion;
    }
    assert.equal(cancelledChain.conversationStore.get(V5_TAB_A), undefined);

    const failedChain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });
    const failedStart = await failedChain.agentRunController.start(V5_TAB_A, 'Buy', {
      askId: 'failed',
    });
    await waitUntil(() =>
      failedChain.aiEvents.some((e) => e.type === 'agent-run-awaiting-approval'),
    );
    const failedPending = lastPendingApproval(failedChain);
    failedChain.agentRunCoordinator.notifyApprovalOutcome(failedPending.approvalId, 'failed');
    if (failedStart.status === 'started') {
      await failedStart.completion;
    }
    assert.equal(failedChain.conversationStore.get(V5_TAB_A), undefined);

    const unknownChain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });
    const unknownStart = await unknownChain.agentRunController.start(V5_TAB_A, 'Buy', {
      askId: 'unknown',
    });
    await waitUntil(() =>
      unknownChain.aiEvents.some((e) => e.type === 'agent-run-awaiting-approval'),
    );
    const unknownPending = lastPendingApproval(unknownChain);
    unknownChain.agentRunCoordinator.notifyApprovalOutcome(
      unknownPending.approvalId,
      'execution-state-unknown',
    );
    if (unknownStart.status === 'started') {
      await unknownStart.completion;
    }
    assert.equal(unknownChain.conversationStore.get(V5_TAB_A), undefined);
  });

  it('uses prior conversation only on the first model step', async () => {
    const page = safePage('Safe control A', 'target-a');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter } = createExecuteFakeAdapter({ observePage: async () => page });
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: stepScriptRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-a' } }),
        () => ({
          kind: 'answer',
          disposition: 'needs-clarification',
          text: 'done',
          referencedTargets: [],
        }),
      ]),
      observation: page,
    });
    chain.conversationStore.commitTurn(V5_TAB_A, page.document.revision, {
      question: 'old',
      answer: 'old answer',
    });
    await startActDirect(chain, V5_TAB_A, 'Continue task');
    const first = chain.runtime.requests[0];
    const second = chain.runtime.requests[1];
    assert.ok(first);
    assert.ok(second);
    const firstHistory = (first.messages ?? [])
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    const secondHistory = (second.messages ?? [])
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    assert.match(firstHistory, /<PRIOR_USER_CONTEXT>/);
    assert.match(firstHistory, /"question":"old"/);
    assert.equal(firstHistory.includes('old answer'), false);
    assert.equal(secondHistory.includes('old answer'), false);
    assert.equal(secondHistory.includes('<PRIOR_USER_CONTEXT>'), false);
    assert.equal(secondHistory.includes('"question":"old"'), false);
  });
});
