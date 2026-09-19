import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TargetRegistry } from '../observation/target-registry';
import { PersistentWorkflowRuntime } from '../main/persistent-workflow-runtime';
import { InteractionError } from '../shared/interaction-errors';
import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';
import { DurableWorkflowError } from '../workflows/durable-workflow-errors';
import {
  buyNowPage,
  childStepRuntime,
  clickRuntime,
  complete,
  createV6ProductChain,
  delegate,
  holdingChildRuntime,
  lastPendingApproval,
  namedButtonPage,
  seedRegistry,
  waitUntil,
  type V6ClickControl,
} from '../v6-acceptance/chain-helpers';
import { RecordingPlannerRuntime } from '../v6-acceptance/recording-planner-runtime';
import { V6AcceptanceModelRuntime } from '../v6-acceptance/recording-agent-model-runtime';
import {
  bindRuntimeToController,
  createV7FakeAdapter,
  FakeTimer,
  sampleWorkflow,
  withTempDirectory,
} from './runtime-helpers';

describe('V7 production authority chain acceptance', () => {
  it('traces persisted workflow → occurrence → runner → V6 → V5 → V4 → adapter click', async () => {
    await withChain({}, async ({ runtime, chain, fake }) => {
      const created = await runtime.createWorkflow(
        sampleWorkflow({
          name: 'Safe click',
          objective: 'Click Safe control A',
          url: 'https://example.test/agent-run/two-safe.html',
        }),
      );
      const queued = await runtime.runWorkflowNow(created.workflowId);
      await runtime.flush();
      await waitUntil(async () => {
        const row = await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId);
        return row?.state === 'completed';
      });
      const terminal = await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId);
      assert.equal(terminal?.state, 'completed');
      assert.equal(fake.created.length, 1);
      assert.equal(fake.created[0]?.activate, false);
      assert.equal(fake.created[0]?.url, 'https://example.test/agent-run/two-safe.html');
      assert.equal(fake.browserState.activeTabId, 'tab-user');
      assert.equal(fake.counts.click, 1);
      assert.equal(fake.counts.input, 1);
      assert.equal(chain.concurrent.max, 1);
      assert.equal(chain.approvalEvents.some((event) => event.type === 'approval-required'), false);
    });
  });

  it('executes the frozen queued URL after the definition is edited', async () => {
    await withChain(
      {
        planner: new RecordingPlannerRuntime([complete('Frozen work done.'), complete('New revision done.')]),
        child: new V6AcceptanceModelRuntime(() => ({
          kind: 'answer',
          text: 'unused',
          referencedTargets: [],
        })),
      },
      async ({ runtime, fake }) => {
        const created = await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Rev freeze',
            objective: 'Objective A',
            url: 'https://example.test/revision-a',
          }),
        );
        const queued = await runtime.runWorkflowNow(created.workflowId);
        await runtime.editWorkflow(created.workflowId, {
          name: 'Rev freeze',
          objective: 'Objective B',
          entryPoint: { kind: 'url', url: 'https://example.test/revision-b' },
          trigger: { kind: 'manual' },
        });
        await runtime.flush();
        await waitUntil(async () => {
          const row = await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId);
          return row?.state === 'completed';
        });
        assert.equal(fake.created[0]?.url, 'https://example.test/revision-a');
        const later = await runtime.runWorkflowNow(created.workflowId);
        await runtime.flush();
        await waitUntil(async () => {
          const row = await runtime.getCoordinator()?.getOccurrence(later.occurrenceId);
          return row?.state === 'completed';
        });
        assert.equal(fake.created[1]?.url, 'https://example.test/revision-b');
        assert.notEqual(later.occurrenceId, queued.occurrenceId);
      },
    );
  });

  it('requires a fresh V4 approval per occurrence and ignores free-text', async () => {
    await withChain(
      {
        planner: new RecordingPlannerRuntime([
          delegate('Click Buy now'),
          complete('First bought.'),
          delegate('Click Buy now'),
          complete('Second bought.'),
        ]),
        child: childStepRuntime([
          () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
          () => ({ kind: 'answer', text: 'Bought A.', referencedTargets: [] }),
          () => ({ kind: 'interaction', proposal: { kind: 'click', targetId: 'target-buy' } }),
          () => ({ kind: 'answer', text: 'Bought B.', referencedTargets: [] }),
        ]),
        pageForUrl: (_url: string, tabId: TabId) => buyNowPage(tabId),
      },
      async ({ runtime, chain, fake }) => {
        const created = await runtime.createWorkflow(
          sampleWorkflow({
            name: 'Buy twice',
            objective: 'Click Buy now',
            url: 'https://example.test/approval/consequential.html',
          }),
        );
        const first = await runtime.runWorkflowNow(created.workflowId);
        await runtime.flush();
        await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
        const live = runtime.getRunner()?.inspectLiveExecution();
        assert.ok(live);
        for (const reply of ['yes', 'approve', 'do it']) {
          assert.equal(chain.controller.reply(live.taskId, reply).ok, false);
        }
        assert.equal(fake.counts.click, 0);
        assert.equal(fake.counts.input, 0);
        assert.equal(
          chain.manager.getSnapshot(lastPendingApproval(chain).approvalId)?.facts.adapterPrimitiveInvoked,
          false,
        );
        const approvalA = lastPendingApproval(chain);
        const snapshotA = chain.manager.getSnapshot(approvalA.approvalId);
        assert.equal((await runtime.getCoordinator()?.getOccurrence(first.occurrenceId))?.state, 'running');
        assert.equal(runtime.getSlotOwner()?.kind, 'workflow');
        assert.equal(runtime.startManualAutonomousTask('manual during approval').ok, false);
        const approved = await chain.workflow.decide({
          approvalId: approvalA.approvalId,
          decision: 'approve',
        });
        assert.equal(approved.ok, true);
        await waitUntil(async () => {
          const row = await runtime.getCoordinator()?.getOccurrence(first.occurrenceId);
          return row?.state === 'completed';
        });
        assert.equal(fake.counts.click, 1);
        assert.equal(fake.counts.input, 1);

        const second = await runtime.runWorkflowNow(created.workflowId);
        await runtime.flush();
        await waitUntil(
          () => chain.approvalEvents.filter((event) => event.type === 'approval-required').length === 2,
        );
        const approvalB = lastPendingApproval(chain);
        assert.notEqual(approvalB.approvalId, approvalA.approvalId);
        assert.notEqual(
          chain.manager.getSnapshot(approvalB.approvalId)?.action.preparedActionId,
          snapshotA?.action.preparedActionId,
        );
        const reused = await chain.workflow.decide({
          approvalId: approvalA.approvalId,
          decision: 'approve',
        });
        assert.equal(reused.ok, false);
        assert.equal(fake.counts.click, 1);
        const approvedB = await chain.workflow.decide({
          approvalId: approvalB.approvalId,
          decision: 'approve',
        });
        assert.equal(approvedB.ok, true);
        await waitUntil(async () => {
          const row = await runtime.getCoordinator()?.getOccurrence(second.occurrenceId);
          return row?.state === 'completed';
        });
        assert.equal(fake.counts.click, 2);
        const grantA = chain.manager.getSnapshot(approvalA.approvalId)?.executionGrant?.executionId;
        const grantB = chain.manager.getSnapshot(approvalB.approvalId)?.executionGrant?.executionId;
        assert.ok(grantA);
        assert.ok(grantB);
        assert.notEqual(grantA, grantB);
      },
    );
  });

  it('maps rejected approval to a durable blocked occurrence without retry', async () => {
    await withChain(
      {
        planner: new RecordingPlannerRuntime([delegate('Click Buy now'), complete('unused')]),
        child: clickRuntime('Buy now'),
        pageForUrl: (_url: string, tabId: TabId) => buyNowPage(tabId),
      },
      async ({ runtime, chain, fake }) => {
        const created = await runtime.createWorkflow(
          sampleWorkflow({
            objective: 'Click Buy now',
            url: 'https://example.test/approval/consequential.html',
          }),
        );
        const queued = await runtime.runWorkflowNow(created.workflowId);
        await runtime.flush();
        await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
        await chain.workflow.decide({
          approvalId: lastPendingApproval(chain).approvalId,
          decision: 'reject',
        });
        await waitUntil(async () => {
          const row = await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId);
          return row?.state === 'blocked';
        });
        assert.equal(fake.counts.click, 0);
        assert.equal(chain.plannerRuntime.requests.length, 1);
        await runtime.flush();
        assert.equal(fake.created.length, 1);
      },
    );
  });

  it('maps post-dispatch unknown through V6 onto V7 without a second click', async () => {
    await withChain(
      {
        planner: new RecordingPlannerRuntime([delegate('Click Buy now'), complete('unused')]),
        child: clickRuntime('Buy now'),
        pageForUrl: (_url: string, tabId: TabId) => buyNowPage(tabId),
        click: {
          afterHookError: new InteractionError('INTERACTION_FAILED', 'input failed after hook'),
        },
      },
      async ({ runtime, chain, fake }) => {
        const created = await runtime.createWorkflow(
          sampleWorkflow({
            objective: 'Click Buy now',
            url: 'https://example.test/approval/consequential.html',
          }),
        );
        const queued = await runtime.runWorkflowNow(created.workflowId);
        await runtime.flush();
        await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
        await chain.workflow.decide({
          approvalId: lastPendingApproval(chain).approvalId,
          decision: 'approve',
        });
        await waitUntil(async () => {
          const row = await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId);
          return row?.state === 'execution-state-unknown';
        });
        assert.equal(fake.counts.click, 1);
        assert.equal((await runtime.getCoordinator()?.getWorkflow(created.workflowId))?.reviewRequired, true);
        await runtime.notifyWorkflowStoreChanged();
        await runtime.flush();
        assert.equal(fake.counts.click, 1);
        await assert.rejects(
          () => runtime.runWorkflowNow(created.workflowId),
          (error: unknown) => error instanceof DurableWorkflowError && error.code === 'WORKFLOW_REVIEW_REQUIRED',
        );
        assert.equal(fake.counts.click, 1);
        await runtime.acknowledgeWorkflowReview(created.workflowId);
        assert.equal(
          (await runtime.getCoordinator()?.getOccurrence(queued.occurrenceId))?.state,
          'execution-state-unknown',
        );
        assert.equal(fake.counts.click, 1);
      },
    );
  });

  it('reconstructs queued work with a fresh tab/task and interrupts running work without replay', async () => {
    await withTempDirectory(async (directory) => {
      const first = await PersistentWorkflowRuntime.initialize({
        directory,
        runtimeSessionId: 'runtime-A',
        now: () => new Date('2026-09-19T10:00:00.000Z'),
        timer: new FakeTimer(),
      });
      const created = await first.createWorkflow(
        sampleWorkflow({
          objective: 'Click Safe control A',
          url: 'https://example.test/agent-run/two-safe.html',
        }),
      );
      const queued = await first.runWorkflowNow(created.workflowId);
      first.dispose();

      const queuedChain = await openChain(directory, 'runtime-B', {});
      try {
        await queuedChain.runtime.flush();
        await waitUntil(() => queuedChain.runtime.getRunner()?.inspectLiveExecution() !== undefined);
        const queuedTab = queuedChain.runtime.getRunner()?.inspectLiveExecution()?.tabId;
        const queuedTask = queuedChain.runtime.getRunner()?.inspectLiveExecution()?.taskId;
        await waitUntil(async () => {
          const row = await queuedChain.runtime.getCoordinator()?.getOccurrence(queued.occurrenceId);
          return row?.state === 'completed';
        });
        assert.equal(queuedChain.fake.created.length, 1);
        assert.equal(queuedChain.fake.created[0]?.tabId, queuedTab);
        queuedChain.forwardEvents = false;
        queuedChain.runtime.dispose();
        queuedChain.chain.dispose();

        const hold = holdingChildRuntime();
        const running = await PersistentWorkflowRuntime.initialize({
          directory,
          runtimeSessionId: 'runtime-C',
          now: () => new Date('2026-09-19T10:01:00.000Z'),
          timer: new FakeTimer(),
        });
        const next = await running.createWorkflow(
          sampleWorkflow({
            name: 'Active',
            objective: 'Hold child',
            url: 'https://example.test/agent-run/two-safe.html',
          }),
        );
        const active = await running.runWorkflowNow(next.workflowId);
        const registry = new TargetRegistry();
        let taskSeq = 0;
        const box: { runtime?: PersistentWorkflowRuntime; forward: boolean } = {
          runtime: running,
          forward: true,
        };
        const chain = createV6ProductChain({
          adapter: queuedChain.fake.adapter,
          targetRegistry: registry,
          plannerRuntime: new RecordingPlannerRuntime([delegate('Click Safe control A')]),
          childRuntime: hold.runtime,
          observationSource: observeAndSeed(queuedChain.fake.adapter, registry),
          browserState: queuedChain.fake.browserState,
          generateTaskId: () => `task-v7-run-${++taskSeq}`,
          emitTask: (event) => {
            if (box.forward) {
              box.runtime?.handleAutonomousTaskEvent(event);
            }
          },
        });
        bindRuntimeToController(running, chain.controller, queuedChain.fake.adapter);
        await running.flush();
        await waitUntil(() => running.getRunner()?.inspectLiveExecution() !== undefined);
        const live = running.getRunner()?.inspectLiveExecution();
        assert.ok(live);
        assert.equal((await running.getCoordinator()?.getOccurrence(active.occurrenceId))?.state, 'running');
        assert.notEqual(live.tabId, queuedTab);
        assert.notEqual(live.taskId, queuedTask);
        assert.equal(queuedChain.fake.created.length, 2);
        box.forward = false;
        running.dispose();
        chain.dispose();

        const recovered = await PersistentWorkflowRuntime.initialize({
          directory,
          runtimeSessionId: 'runtime-D',
          now: () => new Date('2026-09-19T10:02:00.000Z'),
          timer: new FakeTimer(),
        });
        const interrupted = await recovered.getCoordinator()?.getOccurrence(active.occurrenceId);
        assert.equal(interrupted?.state, 'interrupted');
        assert.equal((await recovered.getCoordinator()?.getWorkflow(next.workflowId))?.reviewRequired, true);
        const replay = createV7FakeAdapter();
        const replayRegistry = new TargetRegistry();
        const replayChain = createV6ProductChain({
          adapter: replay.adapter,
          targetRegistry: replayRegistry,
          plannerRuntime: new RecordingPlannerRuntime([
            delegate('Click Safe control A'),
            complete('should not run'),
          ]),
          childRuntime: clickRuntime('Safe control A'),
          observationSource: observeAndSeed(replay.adapter, replayRegistry),
          browserState: replay.browserState,
          generateTaskId: () => 'task-v7-replay',
          emitTask: (event) => recovered.handleAutonomousTaskEvent(event),
        });
        bindRuntimeToController(recovered, replayChain.controller, replay.adapter);
        await recovered.flush();
        assert.equal(replay.created.length, 0);
        assert.equal(replay.counts.click, 0);
        recovered.dispose();
        replayChain.dispose();
      } finally {
        queuedChain.runtime.dispose();
        queuedChain.chain.dispose();
      }
    });
  });
});

async function withChain(
  options: OpenChainOptions,
  fn: (ctx: Awaited<ReturnType<typeof openChain>>) => Promise<void>,
): Promise<void> {
  await withTempDirectory(async (directory) => {
    const ctx = await openChain(directory, 'runtime-chain', options);
    try {
      await fn(ctx);
    } finally {
      ctx.runtime.dispose();
      ctx.chain.dispose();
    }
  });
}

interface OpenChainOptions {
  planner?: RecordingPlannerRuntime;
  child?: V6AcceptanceModelRuntime;
  click?: V6ClickControl;
  pageForUrl?: (url: string, tabId: TabId) => PageObservation;
}

async function openChain(directory: string, session: string, options: OpenChainOptions) {
  const fake = createV7FakeAdapter({
    click: options.click,
    pageForUrl:
      options.pageForUrl ??
      ((_url: string, tabId: TabId) => namedButtonPage('Safe control A', `target-${tabId}`, tabId)),
  });
  const registry = new TargetRegistry();
  const runtime = await PersistentWorkflowRuntime.initialize({
    directory,
    runtimeSessionId: session,
    now: () => new Date('2026-09-19T10:00:00.000Z'),
    timer: new FakeTimer(),
  });
  let taskSeq = 0;
  const box: { runtime: PersistentWorkflowRuntime; forward: boolean } = { runtime, forward: true };
  const chain = createV6ProductChain({
    adapter: fake.adapter,
    targetRegistry: registry,
    plannerRuntime:
      options.planner ??
      new RecordingPlannerRuntime([delegate('Click Safe control A'), complete('Clicked.')]),
    childRuntime:
      options.child ??
      childStepRuntime([
        (context, instruction) => {
          const needle = instruction.toLowerCase().includes('buy') ? 'buy now' : 'safe control a';
          const match = context.nodes.find((node) => (node.name ?? '').toLowerCase().includes(needle));
          if (!match?.targetId) {
            throw new Error(`missing target for ${instruction}`);
          }
          return { kind: 'interaction', proposal: { kind: 'click', targetId: match.targetId } };
        },
        () => ({ kind: 'answer', text: 'Clicked.', referencedTargets: [] }),
      ]),
    observationSource: observeAndSeed(fake.adapter, registry),
    browserState: fake.browserState,
    generateTaskId: () => `task-v7-${session}-${++taskSeq}`,
    emitTask: (event) => {
      if (box.forward) {
        box.runtime.handleAutonomousTaskEvent(event);
      }
    },
  });
  bindRuntimeToController(runtime, chain.controller, fake.adapter);
  return {
    runtime,
    chain,
    fake,
    set forwardEvents(value: boolean) {
      box.forward = value;
    },
  };
}

function observeAndSeed(
  adapter: ReturnType<typeof createV7FakeAdapter>['adapter'],
  registry: TargetRegistry,
) {
  return {
    observePage: async (tabId: TabId) => {
      const page = await adapter.observePage(tabId);
      seedRegistry(registry, page);
      return page;
    },
  };
}
