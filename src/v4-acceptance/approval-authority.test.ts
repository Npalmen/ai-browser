import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAgentModelOutput } from '../ai/interaction-output-schema';
import { ModelError } from '../ai/model-errors';
import { ApprovalManager } from '../approval/approval-manager';
import { TargetRegistry } from '../observation/target-registry';
import { PREPARED_ACTION_TTL_MS } from '../shared/approval-types';
import { InteractionError } from '../shared/interaction-errors';
import { nativeSelectNodes } from '../v3-acceptance/chain-fixtures';
import { findNodeByName } from './context-helpers';
import {
  buyNowPage,
  clickRuntime,
  createExecuteFakeAdapter,
  createV4ProductChain,
  namedButtonPage,
  node,
  observation,
  seedRegistry,
  waitUntil,
} from './chain-helpers';
import {
  FORBIDDEN_AI_EVENT_TOKENS,
  FORBIDDEN_RENDERER_TOKENS,
  V4_PASSWORD_SECRET,
  V4_PROMPT_INJECTION_CANARY,
  V4_TAB_A,
  V4_TAB_B,
} from './fixture-constants';
import { RecordingInteractionModelRuntime } from './recording-interaction-model-runtime';

const CATEGORY_CASES: Array<{ name: string; targetId: string; category: string }> = [
  { name: 'Send message', targetId: 'target-send', category: 'send' },
  { name: 'Submit form', targetId: 'target-submit', category: 'submit' },
  { name: 'Buy now', targetId: 'target-buy', category: 'purchase' },
  { name: 'Confirm purchase', targetId: 'target-purchase', category: 'purchase' },
  { name: 'Delete', targetId: 'target-delete', category: 'delete' },
  { name: 'Publish', targetId: 'target-publish', category: 'publish' },
  { name: 'Book', targetId: 'target-book', category: 'book' },
  { name: 'Reserve', targetId: 'target-reserve', category: 'reserve' },
  { name: 'Save changes', targetId: 'target-account', category: 'account-change' },
];

function auditTypes(chain: ReturnType<typeof createV4ProductChain>): string[] {
  return chain.audit.getEvents().map((event) => event.eventType);
}

function lastPending(chain: ReturnType<typeof createV4ProductChain>) {
  const event = [...chain.events].reverse().find((entry) => entry.type === 'approval-required');
  assert.ok(event);
  assert.equal(event.type, 'approval-required');
  if (event.type !== 'approval-required') {
    throw new Error('expected approval-required');
  }
  return event.approval;
}

describe('V4 approval authority acceptance', () => {
  for (const fixture of CATEGORY_CASES) {
    it(`prepares ${fixture.name} as ${fixture.category} without executing`, async () => {
      const page = namedButtonPage(fixture.name, fixture.targetId, {
        attributes: { type: fixture.name === 'Submit form' ? 'submit' : 'button' },
      });
      const registry = new TargetRegistry();
      seedRegistry(registry, page);
      const { adapter, counts } = createExecuteFakeAdapter();
      const chain = createV4ProductChain({
        adapter,
        targetRegistry: registry,
        runtime: clickRuntime(fixture.name),
        observation: page,
      });

      const result = await chain.agent.interact({
        tabId: V4_TAB_A,
        instruction: `Click ${fixture.name}`,
      });
      assert.equal(result.kind, 'interaction');
      if (result.kind !== 'interaction') {
        return;
      }
      assert.deepEqual(result.result, { status: 'approval-required' });
      assert.equal(counts.click, 0);
      assert.equal(counts.input, 0);

      const pending = lastPending(chain);
      const snapshot = chain.manager.getSnapshot(pending.approvalId);
      assert.ok(snapshot);
      assert.equal(snapshot.action.state, 'pending');
      assert.equal(snapshot.action.category, fixture.category);
      assert.equal(snapshot.facts.grantIssued, false);
      assert.equal(snapshot.facts.grantClaimed, false);
      assert.equal(snapshot.facts.adapterPrimitiveInvoked, false);
      assert.deepEqual(auditTypes(chain).slice(0, 2), ['prepared', 'approval-presented']);
    });
  }

  it('rejects without a grant, click, or fixture mutation', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });

    await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const pending = lastPending(chain);
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'reject',
    });
    assert.equal(decided.ok, true);
    if (decided.ok) {
      assert.equal(decided.decision, 'reject');
      assert.equal(decided.state, 'rejected');
    }
    const snapshot = chain.manager.getSnapshot(pending.approvalId);
    assert.equal(snapshot?.action.state, 'rejected');
    assert.equal(snapshot?.facts.grantIssued, false);
    assert.equal(snapshot?.facts.grantClaimed, false);
    assert.equal(counts.click, 0);
    assert.deepEqual(auditTypes(chain), ['prepared', 'approval-presented', 'rejected']);
  });

  it('approves once through claim, dispatch, observation, and executed', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });

    await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const pending = lastPending(chain);
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(decided.ok, true);
    const snapshot = chain.manager.getSnapshot(pending.approvalId);
    assert.equal(snapshot?.action.state, 'executed');
    assert.equal(snapshot?.facts.grantIssued, true);
    assert.equal(snapshot?.facts.grantClaimed, true);
    assert.equal(snapshot?.facts.adapterPrimitiveInvoked, true);
    assert.equal(snapshot?.facts.postObservationSucceeded, true);
    assert.equal(counts.click, 1);
    assert.equal(counts.hook, 1);
    assert.equal(counts.input, 1);
    assert.deepEqual(auditTypes(chain), [
      'prepared',
      'approval-presented',
      'approved',
      'execute-grant-issued',
      'execution-attempted',
      'executed',
    ]);

    const duplicate = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) {
      assert.equal(duplicate.error.code, 'APPROVAL_ALREADY_DECIDED');
    }
    assert.equal(counts.click, 1);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'executed');
  });

  it('does not automatically retry after execution-attempted-state-unknown', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter({
      observeError: new InteractionError('INTERACTION_FAILED', 'observe failed'),
    });
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });

    await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const pending = lastPending(chain);
    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
    const snapshot = chain.manager.getSnapshot(pending.approvalId);
    assert.equal(snapshot?.action.state, 'execution-attempted-state-unknown');
    assert.equal(snapshot?.facts.adapterPrimitiveInvoked, true);
    assert.equal(counts.click, 1);

    const retry = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(retry.ok, false);
    assert.equal(counts.click, 1);
  });

  it('allows approve at expiresAt - 1 and expires at expiresAt', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });

    await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const pending = lastPending(chain);
    const expiresAt = chain.manager.getSnapshot(pending.approvalId)?.action.expiresAt;
    assert.equal(expiresAt, 1_000 + PREPARED_ACTION_TTL_MS);
    chain.clock.now = (expiresAt ?? 0) - 1;
    const approved = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(approved.ok, true);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'executed');
    assert.equal(counts.click, 1);

    const expiredPage = namedButtonPage('Buy now', 'target-buy-2');
    const expiredRegistry = new TargetRegistry();
    seedRegistry(expiredRegistry, expiredPage);
    const expiredAdapter = createExecuteFakeAdapter();
    const expired = createV4ProductChain({
      adapter: expiredAdapter.adapter,
      targetRegistry: expiredRegistry,
      runtime: clickRuntime('Buy now'),
      observation: expiredPage,
    });
    await expired.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const expiredPending = lastPending(expired);
    expired.clock.now = expired.manager.getSnapshot(expiredPending.approvalId)?.action.expiresAt ?? 0;
    const expiredDecision = await expired.workflow.decide({
      approvalId: expiredPending.approvalId,
      decision: 'approve',
    });
    assert.equal(expiredDecision.ok, false);
    if (!expiredDecision.ok) {
      assert.equal(expiredDecision.error.code, 'APPROVAL_EXPIRED');
    }
    assert.equal(expired.manager.getSnapshot(expiredPending.approvalId)?.action.state, 'expired');
    assert.equal(expiredAdapter.counts.click, 0);
    assert.equal(expired.audit.getEvents().some((event) => event.eventType === 'execute-grant-issued'), false);
  });

  it('keeps tab A pending when tab B is asked, navigated, or approved', async () => {
    const pageA = buyNowPage({ tabId: V4_TAB_A });
    const pageB = namedButtonPage('Buy now', 'target-buy-b', {}, { tabId: V4_TAB_B, observationId: 'obs-b' });
    const registry = new TargetRegistry();
    seedRegistry(registry, pageA);
    seedRegistry(registry, pageB, 501);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: (tabId) => (tabId === V4_TAB_B ? pageB : pageA),
    });

    await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const pendingA = lastPending(chain);
    await chain.agent.interact({ tabId: V4_TAB_B, instruction: 'Buy now' });
    const pendingB = lastPending(chain);
    assert.notEqual(pendingA.approvalId, pendingB.approvalId);
    assert.equal(chain.manager.getSnapshot(pendingA.approvalId)?.action.state, 'pending');

    chain.lifecycle.invalidateTab(V4_TAB_B);
    assert.equal(chain.manager.getSnapshot(pendingA.approvalId)?.action.state, 'pending');
    assert.equal(chain.manager.getSnapshot(pendingB.approvalId)?.action.state, 'stale');

    await chain.workflow.decide({ approvalId: pendingA.approvalId, decision: 'approve' });
    assert.equal(chain.manager.getSnapshot(pendingA.approvalId)?.action.state, 'executed');
    assert.equal(counts.click, 1);
  });

  it('stales the pending approval when a new same-tab request starts', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });

    const first = chain.aiController.startAsk(V4_TAB_A, 'Buy now', 'interact');
    assert.equal(first.ok, true);
    await waitUntil(() =>
      chain.aiEvents.some((event) => event.type === 'interaction-approval-required'),
    );
    const pending = lastPending(chain);

    const second = chain.aiController.startAsk(V4_TAB_A, 'Buy now again', 'interact');
    assert.equal(second.ok, true);
    await waitUntil(() => chain.events.some((event) => event.type === 'approval-stale'));
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'stale');
    const later = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(later.ok, false);
    assert.equal(counts.click, 0);
  });

  it('stales approval and clears conversation without executing', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });

    await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const pending = lastPending(chain);
    const cleared = chain.aiController.clearConversation(V4_TAB_A);
    assert.equal(cleared.ok, true);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'stale');
    assert.equal(
      chain.aiEvents.some((event) => event.type === 'conversation-cleared'),
      true,
    );
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(decided.ok, false);
    assert.equal(counts.click, 0);
  });

  it('closes a tab without later execution or rebind', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });

    await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const pending = lastPending(chain);
    chain.aiController.handleTabClosed(V4_TAB_A);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'stale');
    registry.clearTab(V4_TAB_A);
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(decided.ok, false);
    assert.equal(counts.click, 0);
  });

  it('keeps pending approvals in memory only across runtime disposal', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });
    await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    const pending = lastPending(chain);
    chain.aiController.dispose();
    const replacement = new ApprovalManager();
    assert.equal(replacement.getSnapshot(pending.approvalId), undefined);
  });

  it('keeps renderer and AI events free of execution tokens and secrets', async () => {
    const page = buyNowPage({
      nodes: [
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-buy',
          name: 'Buy now',
          value: V4_PASSWORD_SECRET,
          attributes: { type: 'button' },
        }),
      ],
    });
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
    });

    const started = chain.aiController.startAsk(V4_TAB_A, 'Buy now', 'interact');
    assert.equal(started.ok, true);
    await waitUntil(() =>
      chain.aiEvents.some((event) => event.type === 'interaction-approval-required'),
    );
    await chain.workflow.decide({
      approvalId: lastPending(chain).approvalId,
      decision: 'approve',
    });

    const renderer = JSON.stringify(chain.events);
    for (const token of FORBIDDEN_RENDERER_TOKENS) {
      assert.equal(renderer.includes(token), false, token);
    }
    const approvalRequired = chain.aiEvents.find(
      (event) => event.type === 'interaction-approval-required',
    );
    const aiSerialized = JSON.stringify(approvalRequired);
    for (const token of FORBIDDEN_AI_EVENT_TOKENS) {
      assert.equal(aiSerialized.includes(token), false, token);
    }

    const audit = JSON.stringify(chain.audit.getEvents());
    for (const token of [
      V4_PASSWORD_SECRET,
      'OTP',
      '4111111111111111',
      'PageObservation',
      'screenshot',
      'backendNodeId',
      'frameId',
      'Input.dispatchMouseEvent',
      'chain-of-thought',
    ]) {
      assert.equal(audit.includes(token), false, token);
    }
  });

  it('does not record approval-presented when renderer emission fails and does not execute', async () => {
    const { adapter, counts } = createExecuteFakeAdapter();
    const registry = new TargetRegistry();
    const page = buyNowPage();
    seedRegistry(registry, page);
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: clickRuntime('Buy now'),
      observation: page,
      emit: () => {
        throw new Error('renderer emit failed');
      },
    });
    const result = await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Buy now' });
    assert.equal(result.kind, 'interaction');
    assert.equal(
      chain.audit.getEvents().some((event) => event.eventType === 'approval-presented'),
      false,
    );
    assert.equal(counts.click, 0);
    const prepared = chain.audit.getEvents().filter((event) => event.eventType === 'prepared');
    assert.equal(prepared.length, 1);
    const snapshot = chain.manager.getSnapshot(prepared[0]?.approvalId ?? 'appr-1');
    assert.equal(snapshot?.action.state, 'pending');
    assert.equal(snapshot?.facts.grantClaimed, false);
  });

  it('rejects malicious model authority claims before trusted import', () => {
    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'interaction',
          proposal: {
            kind: 'click',
            targetId: 'target',
            approved: true,
            authority: 'EXECUTE',
            approvalId: 'fake',
          },
        }),
      (error: unknown) => error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
  });

  it('denies sensitive password typing without preparing approval', async () => {
    const page = observation(
      [
        node({
          role: 'textbox',
          tag: 'input',
          targetId: 'target-password',
          name: 'Password',
          states: { editable: true, secret: true },
          attributes: { type: 'password', autocomplete: 'current-password' },
        }),
      ],
      {
        tabId: V4_TAB_A,
        observationId: 'obs-password',
        document: {
          revision: 'rev-password',
          url: 'http://127.0.0.1/interaction/sensitive-fields.html',
          title: 'Sensitive',
          loading: false,
          mainFrameId: 'frame-1',
        },
      },
    );
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: new RecordingInteractionModelRuntime((context) => ({
        kind: 'interaction',
        proposal: {
          kind: 'type',
          targetId: findNodeByName(context, 'Password').targetId,
          text: 'harmless-proposal',
        },
      })),
      observation: page,
    });

    const result = await chain.agent.interact({
      tabId: V4_TAB_A,
      instruction: 'Type the password',
    });
    assert.equal(result.kind, 'interaction');
    if (result.kind === 'interaction') {
      assert.equal(result.result.status, 'denied');
      assert.equal(result.result.errorCode, 'TARGET_SENSITIVE');
    }
    assert.equal(chain.events.length, 0);
    assert.equal(chain.audit.getEvents().length, 0);
    assert.equal(counts.type, 0);
    assert.equal(counts.click, 0);
  });

  it('keeps deferred consequential select denied without a PreparedAction', async () => {
    const page = observation(nativeSelectNodes('target-select', [
      { targetId: 'opt-keep', name: 'Keep account' },
      { targetId: 'opt-delete', name: 'Delete account' },
    ]), {
      tabId: V4_TAB_A,
      observationId: 'obs-select',
      document: {
        revision: 'rev-select',
        url: 'http://127.0.0.1/approval/consequential-select.html',
        title: 'Select',
        loading: false,
        mainFrameId: 'frame-1',
      },
    });
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: new RecordingInteractionModelRuntime((context) => {
        const option = context.nodes
          .find((candidate) => candidate.nativeOptions)
          ?.nativeOptions?.find((entry) => entry.name === 'Delete account');
        const select = context.nodes.find((candidate) => candidate.nativeOptions);
        if (!select?.targetId || !option) {
          throw new Error('select fixture missing');
        }
        return {
          kind: 'interaction',
          proposal: {
            kind: 'select',
            targetId: select.targetId,
            optionTargetId: option.targetId,
          },
        };
      }),
      observation: page,
    });

    const result = await chain.agent.interact({
      tabId: V4_TAB_A,
      instruction: 'Delete the account',
    });
    assert.equal(result.kind, 'interaction');
    if (result.kind === 'interaction') {
      assert.equal(result.result.status, 'denied');
      assert.equal(result.result.errorCode, 'DEFERRED_TO_EXECUTE');
    }
    assert.equal(chain.events.length, 0);
    assert.equal(chain.audit.getEvents().length, 0);
    assert.equal(counts.click, 0);
  });

  it('does not prepare a DENY control', async () => {
    const page = observation(
      [
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-disabled',
          name: 'Buy now',
          states: { disabled: true },
          attributes: { type: 'button' },
        }),
      ],
      { tabId: V4_TAB_A, observationId: 'obs-deny' },
    );
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts } = createExecuteFakeAdapter();
    const chain = createV4ProductChain({
      adapter,
      targetRegistry: registry,
      runtime: new RecordingInteractionModelRuntime((context) => ({
        kind: 'interaction',
        proposal: {
          kind: 'click',
          targetId: findNodeByName(context, 'Buy now').targetId,
        },
      })),
      observation: page,
    });
    const result = await chain.agent.interact({ tabId: V4_TAB_A, instruction: 'Checkout' });
    assert.equal(result.kind, 'interaction');
    if (result.kind === 'interaction') {
      assert.equal(result.result.status, 'denied');
      assert.equal(result.result.errorCode, 'TARGET_DISABLED');
    }
    assert.equal(chain.events.length, 0);
    assert.equal(counts.click, 0);
  });
});
