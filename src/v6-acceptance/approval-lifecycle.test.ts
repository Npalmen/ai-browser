import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import { TargetRegistry } from '../observation/target-registry';
import {
  MAX_AUTONOMOUS_TASK_APPROVALS,
} from '../autonomous-task/autonomous-task-types';
import {
  buyNowPage,
  childStepRuntime,
  clickRuntime,
  complete,
  createV6FakeAdapter,
  createV6ProductChain,
  delegate,
  denyPage,
  holdingChildRuntime,
  lastPendingApproval,
  namedButtonPage,
  seedRegistry,
  waitUntil,
} from './chain-helpers';
import { V6_TAB_B, V6_TASK_ID } from './fixture-constants';
import { RecordingPlannerRuntime } from './recording-planner-runtime';
import { V6AcceptanceModelRuntime } from './recording-agent-model-runtime';

describe('V6 approval lifecycle acceptance', () => {
  it('requires two independent V4 approvals inside one task', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({
      observePage: async () => page,
    });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([
        delegate('Buy then publish'),
        complete('Both approved.'),
      ]),
      childRuntime: childStepRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-publish' } }),
        () => ({ kind: 'answer', text: 'Purchased and published.', referencedTargets: [] }),
      ]),
      observation: page,
      browserState,
    });
    chain.controller.start('Two independent actions');
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    const first = lastPendingApproval(chain);
    const firstSnap = chain.manager.getSnapshot(first.approvalId);
    await chain.workflow.decide({ approvalId: first.approvalId, decision: 'approve' });
    await waitUntil(() => chain.manager.getSnapshot(first.approvalId)?.action.state === 'executed');
    await waitUntil(
      () => chain.approvalEvents.filter((event) => event.type === 'approval-required').length === 2,
    );
    const second = lastPendingApproval(chain);
    assert.notEqual(second.approvalId, first.approvalId);
    const secondSnap = chain.manager.getSnapshot(second.approvalId);
    assert.notEqual(secondSnap?.action.preparedActionId, firstSnap?.action.preparedActionId);
    await chain.workflow.decide({ approvalId: second.approvalId, decision: 'approve' });
    await waitUntil(() => chain.manager.getSnapshot(second.approvalId)?.action.state === 'executed');
    const firstGrant = chain.manager.getSnapshot(first.approvalId)?.executionGrant?.executionId;
    const secondGrant = chain.manager.getSnapshot(second.approvalId)?.executionGrant?.executionId;
    assert.ok(firstGrant);
    assert.ok(secondGrant);
    assert.notEqual(firstGrant, secondGrant);
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'completed');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.taskApprovalCount, 2);
    assert.equal(counts.click, 2);
    chain.dispose();
  });

  it('blocks the fifth approval before PrepareAction', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const clicks = ['target-buy', 'target-publish', 'target-delete', 'target-book', 'target-submit'];
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([
        delegate('Approvals child 1'),
        delegate('Approvals child 2'),
        delegate('Approvals child 3'),
        complete('unused'),
      ]),
      childRuntime: childStepRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: clicks[0]! } }),
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: clicks[1]! } }),
        () => ({ kind: 'answer', text: 'child 1', referencedTargets: [] }),
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: clicks[2]! } }),
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: clicks[3]! } }),
        () => ({ kind: 'answer', text: 'child 2', referencedTargets: [] }),
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: clicks[4]! } }),
        () => ({ kind: 'answer', text: 'should not', referencedTargets: [] }),
      ]),
      observation: page,
      browserState,
    });
    chain.controller.start('Approval budget');
    for (let index = 0; index < MAX_AUTONOMOUS_TASK_APPROVALS; index += 1) {
      await waitUntil(
        () =>
          chain.approvalEvents.filter((event) => event.type === 'approval-required').length > index,
      );
      const pending = lastPendingApproval(chain);
      await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
      await waitUntil(
        () => chain.manager.getSnapshot(pending.approvalId)?.action.state === 'executed',
      );
    }
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'blocked');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.terminalReason, 'TASK_LIMIT_REACHED');
    assert.equal(
      chain.approvalEvents.filter((event) => event.type === 'approval-required').length,
      MAX_AUTONOMOUS_TASK_APPROVALS,
    );
    assert.equal(chain.ids.prepared, MAX_AUTONOMOUS_TASK_APPROVALS);
    assert.equal(chain.ids.approval, MAX_AUTONOMOUS_TASK_APPROVALS);
    chain.dispose();
  });

  it('blocks the whole task on V3 DENY without approval', async () => {
    const page = denyPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Click continue'), complete('unused')]),
      childRuntime: clickRuntime('Continue'),
      observation: page,
      browserState,
    });
    chain.controller.start('Denied action');
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'blocked');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.terminalReason, 'POLICY_BLOCKED');
    assert.equal(chain.approvalEvents.some((event) => event.type === 'approval-required'), false);
    assert.equal(counts.click, 0);
    assert.equal(chain.plannerRuntime.requests.length, 1);
    assert.equal(chain.controller.getCompletedDelegationTurns().length, 0);
    chain.dispose();
  });

  it('blocks the task when approval is rejected', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Buy now'), complete('unused')]),
      childRuntime: clickRuntime('Buy now'),
      observation: page,
      browserState,
    });
    chain.controller.start('Reject purchase');
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    const pending = lastPendingApproval(chain);
    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'reject' });
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'blocked');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.terminalReason, 'APPROVAL_REJECTED');
    assert.equal(counts.click, 0);
    assert.equal(chain.plannerRuntime.requests.length, 1);
    chain.dispose();
  });

  it('blocks the task when approval expires', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Buy now'), complete('unused')]),
      childRuntime: clickRuntime('Buy now'),
      observation: page,
      browserState,
    });
    chain.controller.start('Expire purchase');
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    const pending = lastPendingApproval(chain);
    const expiresAt = chain.manager.getSnapshot(pending.approvalId)?.action.expiresAt;
    assert.ok(expiresAt);
    chain.clock.now = expiresAt;
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(decided.ok, false);
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'blocked');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.terminalReason, 'APPROVAL_EXPIRED');
    assert.equal(counts.click, 0);
    chain.dispose();
  });

  it('blocks the task on natural ACTION_STALE without reprepare', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Buy now'), complete('unused')]),
      childRuntime: clickRuntime('Buy now'),
      observation: page,
      browserState,
    });
    chain.controller.start('Stale purchase');
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    const pending = lastPendingApproval(chain);
    registry.replaceObservation(page.tabId, 'obs-replaced', []);
    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'blocked');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.terminalReason, 'ACTION_STALE');
    assert.equal(counts.click, 0);
    assert.equal(chain.ids.prepared, 1);
    chain.dispose();
  });

  it('kills the whole task on V4 unknown without retry', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({
      observePage: async () => page,
      click: {
        afterHookError: new InteractionError('INTERACTION_FAILED', 'input failed after hook'),
      },
    });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Buy now'), complete('unused')]),
      childRuntime: clickRuntime('Buy now'),
      observation: page,
      browserState,
    });
    chain.controller.start('Unknown purchase');
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    const pending = lastPendingApproval(chain);
    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
    await waitUntil(
      () => chain.coordinator.getTask(V6_TASK_ID)?.state === 'execution-state-unknown',
    );
    assert.equal(counts.click, 1);
    assert.equal(chain.plannerRuntime.requests.length, 1);
    assert.equal(chain.controller.getCompletedDelegationTurns().length, 0);
    const paused = await chain.controller.pause(V6_TASK_ID);
    assert.equal(paused.ok, true);
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'execution-state-unknown');
    chain.dispose();
  });

  it('ignores free-text replies while awaiting approval and still allows approval:decide', async () => {
    const page = buyNowPage();
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Buy now'), complete('Approved.')]),
      childRuntime: childStepRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
        () => ({ kind: 'answer', text: 'Bought.', referencedTargets: [] }),
      ]),
      observation: page,
      browserState,
    });
    chain.controller.start('Free text cannot approve');
    await waitUntil(() =>
      chain.taskEvents.some((event) => event.type === 'autonomous-task-awaiting-approval'),
    );
    for (const reply of ['yes', 'approve', 'do it']) {
      const result = chain.controller.reply(V6_TASK_ID, reply);
      assert.equal(result.ok, false);
    }
    const pending = lastPendingApproval(chain);
    assert.equal(chain.manager.getSnapshot(pending.approvalId)?.action.state, 'pending');
    assert.equal(counts.click, 0);
    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'completed');
    assert.equal(counts.click, 1);
    chain.dispose();
  });

  it('does not correlate a manual Act approval on an unowned tab', async () => {
    const pageA = namedButtonPage('Safe control A', 'target-a');
    const pageB = buyNowPage(V6_TAB_B, {
      observationId: 'obs-b',
      document: {
        revision: 'rev-b',
        url: 'http://127.0.0.1/approval/consequential.html',
        title: 'B',
        loading: false,
        mainFrameId: 'frame-1',
      },
    });
    const registry = new TargetRegistry();
    seedRegistry(registry, pageA);
    seedRegistry(registry, pageB, 701);
    const { adapter, browserState } = createV6FakeAdapter({
      observePage: async (tabId) => (tabId === V6_TAB_B ? pageB : pageA),
    });
    const taskHold = holdingChildRuntime();
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Work on A')]),
      childRuntime: new V6AcceptanceModelRuntime((context, instruction) => {
        if (instruction.includes('Buy on B')) {
          const buy = context.nodes.find((node) => (node.name ?? '').includes('Buy now'));
          if (buy?.targetId) {
            return { kind: 'interaction', proposal: { kind: 'click', targetId: buy.targetId } };
          }
        }
        return taskHold.hold.promise;
      }),
      observation: (tabId) => (tabId === V6_TAB_B ? pageB : pageA),
      browserState,
    });
    chain.controller.start('Task on A');
    await waitUntil(() => chain.childRuns.getActiveChild(V6_TASK_ID) !== undefined);
    const taskApprovals = chain.coordinator.getTask(V6_TASK_ID)?.taskApprovalCount ?? 0;
    const started = await chain.agentRunController.start(V6_TAB_B, 'Buy on B', { askId: 'ask-b' });
    assert.equal(started.status, 'started');
    await waitUntil(() =>
      chain.approvalEvents.some((event) => event.type === 'approval-required' && event.approval.tabId === V6_TAB_B),
    );
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'running-subgoal');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.taskApprovalCount, taskApprovals);
    chain.dispose();
  });
});
