import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import { TargetRegistry } from '../observation/target-registry';
import { websitePopupCreatedEvent } from '../browser/tab-creation';
import {
  answerRuntime,
  buyNowPage,
  childStepRuntime,
  clickRuntime,
  complete,
  createV6FakeAdapter,
  createV6ProductChain,
  Deferred,
  delegate,
  emitTabCreated,
  holdingChildRuntime,
  lastPendingApproval,
  namedButtonPage,
  seedRegistry,
  waitUntil,
  type V6ClickControl,
} from './chain-helpers';
import { V6_TAB_A, V6_TAB_B, V6_TAB_C, V6_TASK_ID } from './fixture-constants';
import { RecordingPlannerRuntime } from './recording-planner-runtime';
import { V6AcceptanceModelRuntime } from './recording-agent-model-runtime';

function pageChain(options: {
  planner: RecordingPlannerRuntime;
  child: V6AcceptanceModelRuntime;
  page?: ReturnType<typeof namedButtonPage>;
  click?: V6ClickControl;
}) {
  const page = options.page ?? namedButtonPage('Safe control A', 'target-a');
  const registry = new TargetRegistry();
  seedRegistry(registry, page);
  const { adapter, counts, browserState } = createV6FakeAdapter({
    observePage: async () => page,
    click: options.click,
  });
  const chain = createV6ProductChain({
    adapter,
    targetRegistry: registry,
    plannerRuntime: options.planner,
    childRuntime: options.child,
    observation: page,
    browserState,
  });
  return { chain, counts, registry, page };
}

describe('V6 lifecycle race acceptance', () => {
  it('pauses an in-flight planner and ignores the late decision', async () => {
    const planner = new RecordingPlannerRuntime();
    planner.hold = new Deferred();
    const { chain } = pageChain({
      planner,
      child: answerRuntime('should not start'),
    });
    chain.controller.start('Pause planner');
    await waitUntil(() => planner.requests.length === 1);
    const paused = await chain.controller.pause(V6_TASK_ID);
    assert.equal(paused.ok, true);
    planner.hold.resolve(delegate('Must not start'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.childRunCount, 0);
    assert.equal(chain.concurrent.runIds.length, 0);
    chain.dispose();
  });

  it('pauses a running child without starting the next planner', async () => {
    const held = holdingChildRuntime();
    const planner = new RecordingPlannerRuntime([
      delegate('Finish fares'),
      delegate('Must not start'),
    ]);
    const { chain } = pageChain({
      planner,
      child: held.runtime,
    });
    chain.controller.start('Pause child');
    await waitUntil(() => chain.childRuns.getActiveChild(V6_TASK_ID) !== undefined);
    const plannerCalls = planner.requests.length;
    const paused = await chain.controller.pause(V6_TASK_ID);
    assert.equal(paused.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    assert.equal(planner.requests.length, plannerCalls);
    assert.equal(chain.concurrent.runIds.length, 1);
    chain.dispose();
  });

  it('ignores a child that completes at the Pause cancel race and a late child after Pause', async () => {
    const raceHold = holdingChildRuntime();
    const racePlanner = new RecordingPlannerRuntime([
      delegate('Finish fares'),
      complete('Must not run'),
    ]);
    const racing = pageChain({
      planner: racePlanner,
      child: raceHold.runtime,
    });
    racing.chain.controller.start('Child completes at cancel');
    await waitUntil(() => racing.chain.childRuns.getActiveChild(V6_TASK_ID) !== undefined);
    const pauseP = racing.chain.controller.pause(V6_TASK_ID);
    raceHold.hold.resolve({ kind: 'answer', text: 'just in time', referencedTargets: [] });
    const paused = await pauseP;
    assert.equal(paused.ok, true);
    const raced = racing.chain.coordinator.getTask(V6_TASK_ID);
    assert.equal(raced?.state, 'paused');
    assert.equal(racePlanner.requests.length, 1);
    racing.chain.dispose();

    const lateHold = holdingChildRuntime();
    const latePlanner = new RecordingPlannerRuntime([delegate('Work'), complete('no')]);
    const late = pageChain({
      planner: latePlanner,
      child: lateHold.runtime,
    });
    late.chain.controller.start('Late child');
    await waitUntil(() => late.chain.childRuns.getActiveChild(V6_TASK_ID) !== undefined);
    const generation = late.chain.coordinator.getTask(V6_TASK_ID)?.generation;
    await late.chain.controller.pause(V6_TASK_ID);
    lateHold.hold.resolve({ kind: 'answer', text: 'stale child', referencedTargets: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(late.chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    assert.equal(late.chain.coordinator.getTask(V6_TASK_ID)?.generation, generation);
    assert.equal(late.chain.coordinator.getTask(V6_TASK_ID)?.lastCompletedSubgoalFingerprint, undefined);
    assert.equal(latePlanner.requests.length, 1);
    late.chain.dispose();
  });

  it('pauses awaiting approval pre-dispatch without ACTION_STALE', async () => {
    const page = buyNowPage();
    const planner = new RecordingPlannerRuntime([delegate('Buy now'), complete('unused')]);
    const { chain } = pageChain({
      planner,
      child: clickRuntime('Buy now'),
      page,
    });
    chain.controller.start('Pause approval');
    await waitUntil(() =>
      chain.taskEvents.some((event) => event.type === 'autonomous-task-awaiting-approval'),
    );
    const pending = lastPendingApproval(chain);
    const paused = await chain.controller.pause(V6_TASK_ID);
    assert.equal(paused.ok, true);
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    assert.notEqual(chain.coordinator.getTask(V6_TASK_ID)?.terminalReason, 'ACTION_STALE');
    const snapshot = chain.manager.getSnapshot(pending.approvalId);
    assert.equal(snapshot?.action.state, 'stale');
    const decided = await chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    assert.equal(decided.ok, false);
    chain.dispose();
  });

  it('pauses after dispatch once V4 has executed and does not continue', async () => {
    const hold = new Deferred<void>();
    const page = buyNowPage();
    const planner = new RecordingPlannerRuntime([
      delegate('Buy now'),
      complete('Must not run'),
    ]);
    const { chain, counts } = pageChain({
      planner,
      child: childStepRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
        () => ({ kind: 'answer', text: 'bought', referencedTargets: [] }),
      ]),
      page,
      click: { afterDispatchHold: () => hold.promise },
    });
    chain.controller.start('Pause after dispatch');
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    const pending = lastPendingApproval(chain);
    const decideP = chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
    await waitUntil(() => counts.hook >= 1);
    const pauseP = chain.controller.pause(V6_TASK_ID);
    hold.resolve();
    await decideP;
    const paused = await pauseP;
    assert.equal(paused.ok, true);
    await waitUntil(
      () =>
        chain.coordinator.getTask(V6_TASK_ID)?.state === 'paused' ||
        chain.coordinator.getTask(V6_TASK_ID)?.state === 'execution-state-unknown',
    );
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    assert.equal(counts.click, 1);
    assert.equal(planner.requests.length, 1);
    chain.dispose();
  });

  it('lets unknown win over Pause after dispatch', async () => {
    const hold = new Deferred<void>();
    const page = buyNowPage();
    const planner = new RecordingPlannerRuntime([delegate('Buy now')]);
    const { chain, counts } = pageChain({
      planner,
      child: clickRuntime('Buy now'),
      page,
      click: {
        afterDispatchHold: () => hold.promise,
        afterHookError: new InteractionError('INTERACTION_FAILED', 'unknown after dispatch'),
      },
    });
    chain.controller.start('Unknown wins pause');
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    const pending = lastPendingApproval(chain);
    const decideP = chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
    await waitUntil(() => counts.hook >= 1);
    const pauseP = chain.controller.pause(V6_TASK_ID);
    hold.resolve();
    await decideP;
    await pauseP;
    await waitUntil(
      () => chain.coordinator.getTask(V6_TASK_ID)?.state === 'execution-state-unknown',
    );
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'execution-state-unknown');
    chain.dispose();
  });

  it('stops after dispatch as cancelled when executed and unknown when unknown', async () => {
    const executedHold = new Deferred<void>();
    const executedPage = buyNowPage();
    const executed = pageChain({
      planner: new RecordingPlannerRuntime([delegate('Buy now'), complete('no')]),
      child: childStepRuntime([
        () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
        () => ({ kind: 'answer', text: 'bought', referencedTargets: [] }),
      ]),
      page: executedPage,
      click: { afterDispatchHold: () => executedHold.promise },
    });
    executed.chain.controller.start('Stop executed');
    await waitUntil(() =>
      executed.chain.approvalEvents.some((event) => event.type === 'approval-required'),
    );
    const pending = lastPendingApproval(executed.chain);
    const decideP = executed.chain.workflow.decide({
      approvalId: pending.approvalId,
      decision: 'approve',
    });
    await waitUntil(() => executed.counts.hook >= 1);
    const stopP = executed.chain.controller.stop(V6_TASK_ID);
    executedHold.resolve();
    await decideP;
    await stopP;
    assert.equal(executed.chain.coordinator.getTask(V6_TASK_ID)?.state, 'cancelled');
    executed.chain.dispose();

    const unknownHold = new Deferred<void>();
    const unknown = pageChain({
      planner: new RecordingPlannerRuntime([delegate('Buy now')]),
      child: clickRuntime('Buy now'),
      page: buyNowPage(),
      click: {
        afterDispatchHold: () => unknownHold.promise,
        afterHookError: new InteractionError('INTERACTION_FAILED', 'unknown'),
      },
    });
    unknown.chain.controller.start('Stop unknown');
    await waitUntil(() =>
      unknown.chain.approvalEvents.some((event) => event.type === 'approval-required'),
    );
    const unknownPending = lastPendingApproval(unknown.chain);
    const unknownDecide = unknown.chain.workflow.decide({
      approvalId: unknownPending.approvalId,
      decision: 'approve',
    });
    await waitUntil(() => unknown.counts.hook >= 1);
    const unknownStop = unknown.chain.controller.stop(V6_TASK_ID);
    unknownHold.resolve();
    await unknownDecide;
    await unknownStop;
    assert.equal(unknown.chain.coordinator.getTask(V6_TASK_ID)?.state, 'execution-state-unknown');
    unknown.chain.dispose();
  });

  it('resumes into a fresh planner epoch and ignores the old result', async () => {
    const planner = new RecordingPlannerRuntime();
    planner.hold = new Deferred();
    const { chain } = pageChain({
      planner,
      child: answerRuntime('unused'),
    });
    chain.controller.start('Resume freshness');
    await waitUntil(() => planner.requests.length === 1);
    const generation = chain.coordinator.getTask(V6_TASK_ID)?.generation;
    await chain.controller.pause(V6_TASK_ID);
    planner.hold.resolve(delegate('stale'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    planner.hold = undefined;
    planner.decisions = [complete('Resumed answer.')];
    const resumed = chain.controller.resume(V6_TASK_ID);
    assert.equal(resumed.ok, true);
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'completed');
    assert.notEqual(chain.coordinator.getTask(V6_TASK_ID)?.generation, generation);
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.childRunCount, 0);
    for (const event of chain.taskEvents) {
      assert.equal(JSON.stringify(event).includes('"generation"'), false);
    }
    chain.dispose();
  });

  it('pauses before trusted chrome navigation and not on generic navigation', async () => {
    const held = holdingChildRuntime();
    const planner = new RecordingPlannerRuntime([delegate('Work on A'), complete('no')]);
    const { chain } = pageChain({
      planner,
      child: held.runtime,
    });
    chain.controller.start('Trusted nav');
    await waitUntil(() => chain.childRuns.getActiveChild(V6_TASK_ID) !== undefined);
    const plannerCalls = planner.requests.length;
    chain.controller.handleGenericNavigation(V6_TAB_A);
    assert.notEqual(chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    await chain.controller.beforeTrustedChromeNavigation(V6_TAB_A);
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    assert.equal(planner.requests.length, plannerCalls);
    chain.dispose();
  });

  it('blocks on execution-tab close and continues after a reference-tab close', async () => {
    const planner = new RecordingPlannerRuntime([delegate('Work on A')]);
    const { chain } = pageChain({
      planner,
      child: holdingChildRuntime().runtime,
    });
    chain.controller.start('Close execution tab');
    await waitUntil(() => chain.childRuns.getActiveChild(V6_TASK_ID) !== undefined);
    const plannerCalls = planner.requests.length;
    await chain.controller.handleTabClosed(V6_TAB_A);
    const task = chain.coordinator.getTask(V6_TASK_ID);
    assert.ok(task);
    assert.equal(['blocked', 'execution-state-unknown', 'failed', 'cancelled'].includes(task.state), true);
    if (task.state === 'blocked') {
      assert.equal(task.terminalReason, 'TAB_UNAVAILABLE');
    }
    assert.equal(planner.requests.length, plannerCalls);
    chain.dispose();

    const held = holdingChildRuntime();
    const reference = pageChain({
      planner: new RecordingPlannerRuntime([delegate('Keep working'), complete('Still going.')]),
      child: held.runtime,
    });
    reference.chain.controller.start('Close reference tab');
    await waitUntil(() => reference.chain.childRuns.getActiveChild(V6_TASK_ID) !== undefined);
    await emitTabCreated(
      reference.chain,
      websitePopupCreatedEvent({
        tabId: V6_TAB_C,
        sourceTabId: V6_TAB_A,
        causedByAgentInputDispatch: true,
      }),
    );
    await waitUntil(() => (reference.chain.coordinator.getTask(V6_TASK_ID)?.ownedTabCount ?? 0) >= 2);
    await reference.chain.controller.handleTabClosed(V6_TAB_C);
    held.hold.resolve({ kind: 'answer', text: 'child', referencedTargets: [] });
    await waitUntil(() => reference.chain.coordinator.getTask(V6_TASK_ID)?.state === 'completed');
    assert.equal(reference.chain.coordinator.getTabOwner(V6_TAB_C), undefined);
    assert.equal(reference.chain.coordinator.getTask(V6_TASK_ID)?.state, 'completed');
    reference.chain.dispose();
  });

  it('rejects Resume of a paused task after its last tab closes', async () => {
    const planner = new RecordingPlannerRuntime();
    planner.hold = new Deferred();
    const { chain } = pageChain({
      planner,
      child: answerRuntime('unused'),
    });
    chain.controller.start('Last tab');
    await waitUntil(() => planner.requests.length === 1);
    await chain.controller.pause(V6_TASK_ID);
    await chain.controller.handleTabClosed(V6_TAB_A);
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.ownedTabCount, 0);
    const resumed = chain.controller.resume(V6_TASK_ID);
    assert.equal(resumed.ok, false);
    chain.dispose();
  });

  it('isolates manual Act from the active task and blocks Act on owned tabs', async () => {
    const held = holdingChildRuntime();
    const planner = new RecordingPlannerRuntime([delegate('Work on A')]);
    const { chain } = pageChain({
      planner,
      child: held.runtime,
    });
    chain.controller.start('Manual isolation');
    await waitUntil(() => chain.childRuns.getActiveChild(V6_TASK_ID) !== undefined);
    const owned = await chain.agentRunController.start(V6_TAB_A, 'Manual on owned', {
      askId: 'ask-owned',
    });
    assert.equal(owned.status, 'ignored');
    assert.equal(chain.conversationStore.get(V6_TAB_A), undefined);
    const unowned = await chain.agentRunController.start(V6_TAB_B, 'Manual on B', {
      askId: 'ask-b',
    });
    assert.equal(unowned.status, 'started');
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'running-subgoal');
    chain.dispose();
  });

  it('allows manual Act on a paused owned tab and rejects Resume while it is active', async () => {
    const planner = new RecordingPlannerRuntime();
    planner.hold = new Deferred();
    const held = holdingChildRuntime();
    const page = namedButtonPage('Safe control A', 'target-a');
    const { chain } = pageChain({
      planner,
      child: held.runtime,
      page,
    });
    chain.controller.start('Paused takeover');
    await waitUntil(() => planner.requests.length === 1);
    await chain.controller.pause(V6_TASK_ID);
    const manual = await chain.agentRunController.start(V6_TAB_A, 'Take over', { askId: 'ask-1' });
    assert.equal(manual.status, 'started');
    const resumed = chain.controller.resume(V6_TASK_ID);
    assert.equal(resumed.ok, false);
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'paused');
    chain.dispose();
  });
});
