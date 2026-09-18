import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TargetRegistry } from '../observation/target-registry';
import {
  buyNowPage,
  multiStepPage,
  clickRuntime,
  createExecuteFakeAdapter,
  createV5ProductChain,
  lastPendingApproval,
  namedButtonPage,
  seedRegistry,
  startActDirect,
  stepScriptRuntime,
  waitUntil,
} from './chain-helpers';
import { V5_TAB_A } from './fixture-constants';

describe('V5 adversarial acceptance', () => {
  it('does not execute after visually identical target replacement', async () => {
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
    registry.replaceObservation(page.tabId, 'obs-replaced', []);
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(decided.ok, true);
    await waitUntil(
      () => chain.manager.getSnapshot(pending.approvalId)?.action.state === 'stale',
    );
    assert.equal(counts.click, 0);
    if (started.status === 'started') {
      const result = await started.completion;
      assert.equal(result.status, 'terminal');
      if (result.status === 'terminal') {
        assert.equal(result.run.terminalReason, 'ACTION_STALE');
      }
    }
  });

  it('permits same-label control after document revision changes', async () => {
    const pageA = namedButtonPage('Repeat safe', 'target-repeat', {}, {
      document: {
        revision: 'rev-a',
        url: 'http://127.0.0.1/agent-run/repeat-safe.html',
        title: 'Repeat',
        loading: false,
        mainFrameId: 'frame-1',
      },
    });
    const pageB = namedButtonPage('Repeat safe', 'target-repeat-b', {}, {
      observationId: 'obs-b',
      document: {
        revision: 'rev-b',
        url: 'http://127.0.0.1/agent-run/repeat-safe.html',
        title: 'Repeat',
        loading: false,
        mainFrameId: 'frame-1',
      },
    });
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
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-repeat' } }),
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-repeat-b' } }),
        () => ({ kind: 'answer', text: 'done', referencedTargets: [] }),
      ]),
      observation: [pageA, pageB],
    });
    const result = await startActDirect(chain, V5_TAB_A, 'Repeat on new revision');
    assert.equal(result.status, 'completed');
    assert.equal(counts.click, 2);
  });

  it('requires independent approval for each consequential action', async () => {
    const page = multiStepPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter } = createExecuteFakeAdapter({ observePage: async () => page });
    const chain = createV5ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: stepScriptRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-publish' } }),
        () => ({ kind: 'answer', text: 'done', referencedTargets: [] }),
      ]),
      observation: page,
    });
    const started = await chain.agentRunController.start(V5_TAB_A, 'Two buys', { askId: 'ask-1' });
    assert.equal(started.status, 'started');
    const approvalIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await waitUntil(
        () => chain.approvalEvents.filter((e) => e.type === 'approval-required').length > i,
      );
      const pending = lastPendingApproval(chain);
      approvalIds.push(pending.approvalId);
      await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
      await waitUntil(
        () => chain.manager.getSnapshot(pending.approvalId)?.action.state === 'executed',
      );
    }
    assert.notEqual(approvalIds[0], approvalIds[1]);
    if (started.status === 'started') {
      const result = await started.completion;
      assert.equal(result.status, 'completed');
      if (result.status === 'completed') {
        assert.equal(result.run.approvalCount, 2);
        assert.equal(result.run.actionAttemptCount, 4);
      }
    }
  });
});
