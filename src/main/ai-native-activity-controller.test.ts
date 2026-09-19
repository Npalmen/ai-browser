import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { AutonomousTaskView } from '../shared/autonomous-task-types';
import type { BrowserState, TabId } from '../shared/browser-types';
import type { WorkflowGetStateResult, WorkflowSummaryView } from '../shared/workflow-product-types';
import { chooseActivityAttention } from './ai-native-activity-attention';
import {
  AiNativeActivityController,
  type ActivitySlotOwner,
  type AiNativeActivityControllerDependencies,
} from './ai-native-activity-controller';

const ROOT = path.resolve(__dirname, '..', '..');

function browserState(tabIds: readonly TabId[]): BrowserState {
  return {
    activeTabId: tabIds[0] ?? 'tab-a',
    tabs: tabIds.map((id) => ({
      id,
      url: `https://example.test/${id}`,
      title: id,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })),
  };
}

function task(overrides: Partial<AutonomousTaskView> & Pick<AutonomousTaskView, 'taskId' | 'state'>): AutonomousTaskView {
  return {
    plannerStepCount: 1,
    childRunCount: 0,
    ownedTabCount: 1,
    taskApprovalCount: 0,
    limits: { plannerSteps: 8, childRuns: 4, ownedTabs: 3, approvals: 4 },
    ownedTabIds: ['tab-a'],
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowSummaryView> = {}): WorkflowSummaryView {
  return {
    workflowId: 'wf-1',
    name: 'Named',
    enabled: true,
    reviewRequired: false,
    definitionRevision: 1,
    trigger: { kind: 'manual' },
    nextRunAt: null,
    queuedCount: 0,
    running: false,
    lastResult: null,
    ...overrides,
  };
}

function controllerOf(overrides: Partial<AiNativeActivityControllerDependencies> = {}) {
  const deps: AiNativeActivityControllerDependencies = {
    getAskSnapshots: () => [],
    hasSelectedContextAsk: () => false,
    getTasks: () => [],
    getSlotOwner: () => undefined,
    getWorkflowState: async () => ({ ok: true, status: 'ready', workflows: [] }),
    getBrowserState: () => browserState(['tab-a']),
    hasPendingApproval: () => false,
    ...overrides,
  };
  return new AiNativeActivityController(deps);
}

describe('chooseActivityAttention', () => {
  it('orders approval above delegate input and workflow review', () => {
    assert.deepEqual(
      chooseActivityAttention({
        approvalTabId: 'tab-b',
        delegateAwaitingUserInput: true,
        workflowReviewRequired: true,
      }),
      { kind: 'approval', tabId: 'tab-b' },
    );
    assert.deepEqual(
      chooseActivityAttention({
        approvalTabId: null,
        delegateAwaitingUserInput: true,
        workflowReviewRequired: true,
      }),
      { kind: 'delegate-user-input' },
    );
    assert.deepEqual(
      chooseActivityAttention({
        approvalTabId: null,
        delegateAwaitingUserInput: false,
        workflowReviewRequired: true,
      }),
      { kind: 'workflow-review' },
    );
    assert.equal(
      chooseActivityAttention({
        approvalTabId: null,
        delegateAwaitingUserInput: false,
        workflowReviewRequired: false,
      }),
      null,
    );
  });
});

describe('AiNativeActivityController', () => {
  it('returns a zero summary for an empty runtime', async () => {
    const result = await controllerOf().getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.ask.activeCount, 0);
    assert.equal(result.summary.act.activeCount, 0);
    assert.equal(result.summary.delegate.active, false);
    assert.equal(result.summary.approval.pendingCount, 0);
    assert.equal(result.summary.workflows.runningCount, 0);
    assert.equal(result.summary.attention, null);
    assert.equal('approvalId' in result.summary, false);
    assert.equal('preparedActionId' in result.summary, false);
    assert.equal('executionId' in result.summary, false);
    assert.equal('targetId' in result.summary, false);
    assert.equal('grant' in result.summary, false);
  });

  it('counts current-tab Ask and selected-tabs Ask without treating them as Act', async () => {
    const result = await controllerOf({
      getAskSnapshots: () => [{ tabId: 'tab-a', mode: 'read' }],
      hasSelectedContextAsk: () => true,
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.ask.activeCount, 2);
    assert.equal(result.summary.ask.selectedContextActive, true);
    assert.equal(result.summary.act.activeCount, 0);
  });

  it('counts interact requests as Act', async () => {
    const result = await controllerOf({
      getAskSnapshots: () => [{ tabId: 'tab-a', mode: 'interact' }],
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.act.activeCount, 1);
    assert.equal(result.summary.ask.activeCount, 0);
  });

  it('does not treat paused or terminal manual tasks as Delegate activity', async () => {
    for (const state of [
      'paused',
      'completed',
      'cancelled',
      'blocked',
      'failed',
      'execution-state-unknown',
    ] as const) {
      const result = await controllerOf({
        getSlotOwner: () => ({ kind: 'manual', taskId: 'task-1' }),
        getTasks: () => [task({ taskId: 'task-1', state })],
      }).getSummary();
      assert.equal(result.ok, true, state);
      if (!result.ok) {
        return;
      }
      assert.equal(result.summary.delegate.active, false, state);
      assert.equal(result.summary.delegate.awaitingUserInput, false, state);
      assert.equal(result.summary.attention, null, state);
    }
  });

  it('counts a manual slot-owned task as Delegate', async () => {
    const result = await controllerOf({
      getSlotOwner: () => ({ kind: 'manual', taskId: 'task-1' }),
      getTasks: () => [task({ taskId: 'task-1', state: 'planning' })],
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.delegate.active, true);
    assert.equal(result.summary.delegate.awaitingUserInput, false);
  });

  it('does not double-count a workflow-owned V6 task as Delegate', async () => {
    const result = await controllerOf({
      getSlotOwner: () => ({ kind: 'workflow', taskId: 'task-1' } satisfies ActivitySlotOwner),
      getTasks: () => [task({ taskId: 'task-1', state: 'running-subgoal' })],
      getWorkflowState: async () => ({
        ok: true,
        status: 'ready',
        workflows: [workflow({ running: true })],
      }),
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.delegate.active, false);
    assert.equal(result.summary.workflows.runningCount, 1);
  });

  it('counts a workflow-owned slot as workflow activity even if product running is false', async () => {
    const result = await controllerOf({
      getSlotOwner: () => ({ kind: 'workflow', taskId: 'task-1' }),
      getTasks: () => [task({ taskId: 'task-1', state: 'running-subgoal' })],
      getWorkflowState: async () => ({
        ok: true,
        status: 'ready',
        workflows: [workflow({ running: false })],
      }),
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.delegate.active, false);
    assert.equal(result.summary.workflows.runningCount, 1);
  });

  it('treats manual awaiting-user-input as delegate attention', async () => {
    const result = await controllerOf({
      getSlotOwner: () => ({ kind: 'manual', taskId: 'task-1' }),
      getTasks: () => [task({ taskId: 'task-1', state: 'awaiting-user-input' })],
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.delegate.active, true);
    assert.equal(result.summary.delegate.awaitingUserInput, true);
    assert.deepEqual(result.summary.attention, { kind: 'delegate-user-input' });
  });

  it('uses pending approvals as highest attention, including background tabs', async () => {
    const pending = new Set<TabId>(['tab-b']);
    const result = await controllerOf({
      getBrowserState: () => browserState(['tab-a', 'tab-b']),
      hasPendingApproval: (tabId) => pending.has(tabId),
      getSlotOwner: () => ({ kind: 'manual', taskId: 'task-1' }),
      getTasks: () => [task({ taskId: 'task-1', state: 'awaiting-user-input' })],
      getWorkflowState: async () => ({
        ok: true,
        status: 'ready',
        workflows: [workflow({ reviewRequired: true })],
      }),
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.approval.pendingCount, 1);
    assert.deepEqual(result.summary.attention, { kind: 'approval', tabId: 'tab-b' });
  });

  it('uses workflow review attention when it is the highest remaining need', async () => {
    const result = await controllerOf({
      getWorkflowState: async () => ({
        ok: true,
        status: 'ready',
        workflows: [workflow({ reviewRequired: true })],
      }),
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.workflows.reviewRequiredCount, 1);
    assert.deepEqual(result.summary.attention, { kind: 'workflow-review' });
  });

  it('sums queued counts and counts running workflows', async () => {
    const result = await controllerOf({
      getWorkflowState: async (): Promise<WorkflowGetStateResult> => ({
        ok: true,
        status: 'ready',
        workflows: [
          workflow({ workflowId: 'wf-1', queuedCount: 2, running: true }),
          workflow({ workflowId: 'wf-2', queuedCount: 3, running: false }),
        ],
      }),
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.summary.workflows.queuedCount, 5);
    assert.equal(result.summary.workflows.runningCount, 1);
  });

  it('does not invent workflow activity for storage-error or not-initialized', async () => {
    const storage = await controllerOf({
      getSlotOwner: () => ({ kind: 'workflow', taskId: 'task-1' }),
      getWorkflowState: async () => ({ ok: true, status: 'storage-error', workflows: [] }),
    }).getSummary();
    assert.equal(storage.ok, true);
    if (storage.ok) {
      assert.equal(storage.summary.workflows.runningCount, 0);
      assert.equal(storage.summary.workflows.queuedCount, 0);
    }
    const missing = await controllerOf({
      getWorkflowState: async () => ({ ok: true, status: 'not-initialized', workflows: [] }),
    }).getSummary();
    assert.equal(missing.ok, true);
    if (missing.ok) {
      assert.equal(missing.summary.workflows.runningCount, 0);
    }
    const failed = await controllerOf({
      getWorkflowState: async () => ({
        ok: false,
        error: { code: 'WORKFLOW_STORAGE_ERROR', message: 'hidden' },
      }),
    }).getSummary();
    assert.equal(failed.ok, true);
    if (failed.ok) {
      assert.equal(failed.summary.workflows.runningCount, 0);
      assert.equal(JSON.stringify(failed.summary).includes('hidden'), false);
    }
  });

  it('returns a safe failure when projection throws', async () => {
    const result = await controllerOf({
      getBrowserState: () => {
        throw new Error('secret-stack');
      },
    }).getSummary();
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.error.code, 'AI_NATIVE_ACTIVITY_FAILED');
    assert.equal(result.error.message.includes('secret-stack'), false);
  });

  it('omits authority-shaped keys from the summary', async () => {
    const result = await controllerOf({
      getAskSnapshots: () => [{ tabId: 'tab-a', mode: 'read' }],
      hasPendingApproval: (tabId) => tabId === 'tab-a',
    }).getSummary();
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const encoded = JSON.stringify(result.summary);
    for (const banned of [
      'approvalId',
      'preparedActionId',
      'executionId',
      'targetId',
      'observationId',
      'documentRevision',
      'grant',
      'executeGrant',
      'pageText',
      'screenshot',
      'prompt',
      'reasoning',
      'occurrenceId',
      'triggerKey',
    ]) {
      assert.equal(encoded.includes(banned), false, banned);
    }
  });

  it('does not import mutation or execution authority surfaces', () => {
    const sources = [
      readFileSync(path.join(ROOT, 'src/main/ai-native-activity-controller.ts'), 'utf8'),
      readFileSync(path.join(ROOT, 'src/main/ai-native-activity-attention.ts'), 'utf8'),
    ];
    for (const source of sources) {
      for (const banned of [
        'ApprovalWorkflowController',
        'ApprovalController',
        'ExecuteExecutor',
        'InteractionExecutor',
        '.runNow',
        '.setEnabled',
        '.acknowledgeReview',
        '.start(',
        '.pause(',
        '.resume(',
        '.stop(',
        '.reply(',
        '.navigate(',
        '.click(',
        '.type(',
        'AiSdkGatewayRuntime',
        'ModelRuntime',
      ]) {
        assert.equal(source.includes(banned), false, banned);
      }
    }
  });
});
