import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TargetRegistry } from '../observation/target-registry';
import { DurableWorkflowCoordinator } from './durable-workflow-coordinator';
import { WorkflowOccurrenceRunner } from './workflow-occurrence-runner';
import type { CreateDurableWorkflowInput, WorkflowStorePort } from '../workflows/durable-workflow-types';
import {
  WORKFLOW_STORE_SCHEMA_VERSION,
  type WorkflowStoreMutation,
  type WorkflowStoreSnapshot,
} from '../workflows/workflow-store-types';
import type { AutonomousTaskEvent } from '../shared/autonomous-task-types';
import type { TabId } from '../shared/browser-types';
import {
  buyNowPage,
  clickRuntime,
  createV6FakeAdapter,
  createV6ProductChain,
  delegate,
  lastPendingApproval,
  seedRegistry,
  waitUntil,
  complete,
} from '../v6-acceptance/chain-helpers';
import { V6_TASK_ID } from '../v6-acceptance/fixture-constants';
import { RecordingPlannerRuntime } from '../v6-acceptance/recording-planner-runtime';
import { InteractionError } from '../shared/interaction-errors';

const USER_TAB: TabId = 'tab-user';
const WORKFLOW_TAB: TabId = 'tab-workflow';
const BASE_TIME = Date.parse('2026-09-19T14:00:00.000Z');

describe('WorkflowOccurrenceRunner production chain', () => {
  it('starts a fresh V6 task, keeps V4 approval, and maps rejection without retry', async () => {
    const page = buyNowPage(WORKFLOW_TAB);
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({
      activeTabId: USER_TAB,
      observePage: async (tabId) => buyNowPage(tabId),
    });
    const created: { url?: string; activate?: boolean }[] = [];
    const activateCalls: TabId[] = [];
    adapter.createTab = async (input) => {
      created.push({ url: input?.url, activate: input?.activate });
      if (!browserState.tabs.some((tab) => tab.id === WORKFLOW_TAB)) {
        browserState.tabs.push({ id: WORKFLOW_TAB });
      }
      return WORKFLOW_TAB;
    };
    const originalActivate = adapter.activateTab.bind(adapter);
    adapter.activateTab = async (tabId) => {
      activateCalls.push(tabId);
      return originalActivate(tabId);
    };

    const store = new MemoryWorkflowStore();
    const workflowCoordinator = new DurableWorkflowCoordinator({
      store,
      now: () => new Date(BASE_TIME),
      newWorkflowId: () => 'wf-chain-1',
      newOccurrenceId: () => 'occ-chain-1',
    });
    await workflowCoordinator.initialize('runtime-chain');
    const workflow = await workflowCoordinator.createWorkflow(sampleInput());
    const occurrence = await workflowCoordinator.enqueueManualOccurrence(workflow.workflowId);

    let eventGate = Promise.resolve();
    const box: { runner?: WorkflowOccurrenceRunner } = {};
    const taskEvents: AutonomousTaskEvent[] = [];
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Buy now'), complete('unused')]),
      childRuntime: clickRuntime('Buy now'),
      observation: page,
      browserState,
      emitTask: (event: AutonomousTaskEvent) => {
        taskEvents.push(event);
        eventGate = eventGate.then(() => box.runner?.handleAutonomousTaskEvent(event) ?? Promise.resolve());
      },
    });
    const runner = new WorkflowOccurrenceRunner({
      durable: workflowCoordinator,
      browser: {
        createTab: (input) => adapter.createTab(input),
        closeTab: (tabId) => adapter.closeTab(tabId),
      },
      autonomousTasks: chain.controller,
    });
    box.runner = runner;

    const started = await runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(started.status, 'started');
    assert.equal(created[0]?.url, 'https://example.test/a');
    assert.equal(created[0]?.activate, false);
    assert.equal(browserState.activeTabId, USER_TAB);
    assert.deepEqual(activateCalls, []);
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.startingTabId, WORKFLOW_TAB);

    const durableAfterStart = await workflowCoordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(durableAfterStart?.state, 'running');
    assert.equal('tabId' in (durableAfterStart ?? {}), false);
    assert.equal('taskId' in (durableAfterStart ?? {}), false);
    assert.equal('approvalId' in (durableAfterStart ?? {}), false);
    assert.equal('targetId' in (durableAfterStart ?? {}), false);
    assert.equal(durableAfterStart?.frozenDefinition.objective, 'Research A');
    assert.equal(durableAfterStart?.frozenDefinition.entryPoint.url, 'https://example.test/a');

    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    await eventGate;
    assert.equal(taskEvents.some((event) => event.type === 'autonomous-task-awaiting-approval'), true);
    assert.equal((await workflowCoordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(counts.click, 0);
    assert.equal(counts.input, 0);
    assert.equal(runner.getActiveOccurrence()?.occurrenceId, occurrence.occurrenceId);

    const pending = lastPendingApproval(chain);
    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'reject' });
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'blocked');
    await eventGate;

    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.terminalReason, 'APPROVAL_REJECTED');
    const terminal = await workflowCoordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'blocked');
    assert.equal(terminal?.terminalReason, 'APPROVAL_REJECTED');
    assert.equal(counts.click, 0);
    assert.equal(runner.inspectLiveExecution(), undefined);
    assert.equal(created.length, 1);
    assert.equal(chain.plannerRuntime.requests.length, 1);
    chain.dispose();
  });

  it('maps V4 post-dispatch unknown through V6 onto durable unknown + reviewRequired', async () => {
    const page = buyNowPage(WORKFLOW_TAB);
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({
      activeTabId: USER_TAB,
      observePage: async (tabId) => buyNowPage(tabId),
      click: {
        afterHookError: new InteractionError('INTERACTION_FAILED', 'input failed after hook'),
      },
    });
    adapter.createTab = async (input) => {
      if (!browserState.tabs.some((tab) => tab.id === WORKFLOW_TAB)) {
        browserState.tabs.push({ id: WORKFLOW_TAB });
      }
      assert.equal(input?.activate, false);
      return WORKFLOW_TAB;
    };

    const store = new MemoryWorkflowStore();
    const workflowCoordinator = new DurableWorkflowCoordinator({
      store,
      now: () => new Date(BASE_TIME),
      newWorkflowId: () => 'wf-chain-2',
      newOccurrenceId: () => 'occ-chain-2',
    });
    await workflowCoordinator.initialize('runtime-chain-2');
    const workflow = await workflowCoordinator.createWorkflow(sampleInput());
    const occurrence = await workflowCoordinator.enqueueManualOccurrence(workflow.workflowId);

    let eventGate = Promise.resolve();
    const box: { runner?: WorkflowOccurrenceRunner } = {};
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Buy now'), complete('unused')]),
      childRuntime: clickRuntime('Buy now'),
      observation: page,
      browserState,
      emitTask: (event: AutonomousTaskEvent) => {
        eventGate = eventGate.then(() => box.runner?.handleAutonomousTaskEvent(event) ?? Promise.resolve());
      },
    });
    const runner = new WorkflowOccurrenceRunner({
      durable: workflowCoordinator,
      browser: {
        createTab: (input) => adapter.createTab(input),
        closeTab: (tabId) => adapter.closeTab(tabId),
      },
      autonomousTasks: chain.controller,
    });
    box.runner = runner;

    const started = await runner.startOccurrence(occurrence.occurrenceId);
    assert.equal(started.status, 'started');
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    const pending = lastPendingApproval(chain);
    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'approve' });
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'execution-state-unknown');
    await eventGate;

    assert.equal(counts.click, 1);
    const terminal = await workflowCoordinator.getOccurrence(occurrence.occurrenceId);
    assert.equal(terminal?.state, 'execution-state-unknown');
    const definition = await workflowCoordinator.getWorkflow(workflow.workflowId);
    assert.equal(definition?.reviewRequired, true);
    assert.equal(chain.plannerRuntime.requests.length, 1);
    assert.equal(runner.inspectLiveExecution(), undefined);
    chain.dispose();
  });
});

function sampleInput(): CreateDurableWorkflowInput {
  return {
    name: 'Research',
    objective: 'Research A',
    entryPoint: { kind: 'url', url: 'https://example.test/a' },
    trigger: { kind: 'manual' },
  };
}

class MemoryWorkflowStore implements WorkflowStorePort {
  private snapshot: WorkflowStoreSnapshot = {
    schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
    storeRevision: 0,
    workflows: [],
    occurrences: [],
  };

  async load(): Promise<WorkflowStoreSnapshot> {
    return structuredClone(this.snapshot);
  }

  async commit(
    expectedStoreRevision: number,
    mutation: WorkflowStoreMutation,
  ): Promise<WorkflowStoreSnapshot> {
    if (expectedStoreRevision !== this.snapshot.storeRevision) {
      throw new Error('Workflow store revision conflict.');
    }
    const payload = mutation(structuredClone(this.snapshot));
    this.snapshot = {
      schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
      storeRevision: this.snapshot.storeRevision + 1,
      workflows: structuredClone(payload.workflows),
      occurrences: structuredClone(payload.occurrences),
    };
    return structuredClone(this.snapshot);
  }
}
