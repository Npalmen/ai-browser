import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { TargetRegistry } from '../observation/target-registry';
import { PersistentWorkflowRuntime } from './persistent-workflow-runtime';
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
import { RecordingPlannerRuntime } from '../v6-acceptance/recording-planner-runtime';
import { V6_TASK_ID } from '../v6-acceptance/fixture-constants';
import type { TabId } from '../shared/browser-types';

const USER_TAB: TabId = 'tab-user';
const WORKFLOW_TAB: TabId = 'tab-workflow';
const BASE_TIME = Date.parse('2026-09-19T14:00:00.000Z');

describe('PersistentWorkflowRuntime production chain', () => {
  it('keeps V4 approval and rejects manual Delegate while the workflow slot is owned', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-life-chain-'));
    const page = buyNowPage(WORKFLOW_TAB);
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, counts, browserState } = createV6FakeAdapter({
      activeTabId: USER_TAB,
      observePage: async (tabId) => buyNowPage(tabId),
    });
    adapter.createTab = async (input) => {
      if (!browserState.tabs.some((tab) => tab.id === WORKFLOW_TAB)) {
        browserState.tabs.push({ id: WORKFLOW_TAB });
      }
      assert.equal(input?.activate, false);
      return WORKFLOW_TAB;
    };

    const runtime = await PersistentWorkflowRuntime.initialize({
      directory,
      runtimeSessionId: 'runtime-chain',
      now: () => new Date(BASE_TIME),
    });
    const coordinator = runtime.getCoordinator();
    assert.ok(coordinator);
    const workflow = await coordinator.createWorkflow({
      name: 'Buy',
      objective: 'Buy now',
      entryPoint: { kind: 'url', url: 'https://example.test/buy' },
      trigger: { kind: 'manual' },
    });
    const occurrence = await coordinator.enqueueManualOccurrence(workflow.workflowId);

    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([delegate('Buy now'), complete('unused')]),
      childRuntime: clickRuntime('Buy now'),
      observation: page,
      browserState,
      generateTaskId: () => V6_TASK_ID,
      emitTask: (event) => runtime.handleAutonomousTaskEvent(event),
    });
    runtime.attachExecutionRuntime({
      browser: {
        createTab: (input) => adapter.createTab(input),
        closeTab: (tabId) => adapter.closeTab(tabId),
      },
      autonomousTasks: chain.controller,
    });
    await runtime.flush();
    await waitUntil(() => chain.approvalEvents.some((event) => event.type === 'approval-required'));
    await runtime.flush();

    assert.equal((await coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');
    assert.equal(counts.click, 0);
    const pending = lastPendingApproval(chain);
    const manual = runtime.startManualAutonomousTask('Take over');
    assert.equal(manual.ok, false);
    assert.equal(chain.coordinator.getTask(V6_TASK_ID)?.state, 'awaiting-approval');
    assert.equal((await coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'running');

    await chain.workflow.decide({ approvalId: pending.approvalId, decision: 'reject' });
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'blocked');
    await runtime.flush();
    assert.equal((await coordinator.getOccurrence(occurrence.occurrenceId))?.state, 'blocked');
    assert.equal(counts.click, 0);
    chain.dispose();
    runtime.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
});
