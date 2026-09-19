import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { WORKFLOW_STORE_SCHEMA_VERSION } from '../workflows/workflow-store-types';
import { parseWorkflowDraft, WorkflowDraftValidationError } from '../ai-native/workflow-draft';
import { chooseActivityAttention } from '../main/ai-native-activity-attention';
import {
  AiNativeActivityController,
  type AiNativeActivityControllerDependencies,
} from '../main/ai-native-activity-controller';
import type { AutonomousTaskView } from '../shared/autonomous-task-types';
import type { BrowserState, TabId } from '../shared/browser-types';
import type { WorkflowSummaryView } from '../shared/workflow-product-types';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

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

function task(state: AutonomousTaskView['state']): AutonomousTaskView {
  return {
    taskId: 'task-1',
    state,
    plannerStepCount: 1,
    childRunCount: 0,
    ownedTabCount: 1,
    taskApprovalCount: 0,
    limits: { plannerSteps: 8, childRuns: 4, ownedTabs: 3, approvals: 4 },
    ownedTabIds: ['tab-a'],
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

function controller(overrides: Partial<AiNativeActivityControllerDependencies> = {}) {
  return new AiNativeActivityController({
    getAskSnapshots: () => [],
    hasSelectedContextAsk: () => false,
    getTasks: () => [],
    getSlotOwner: () => undefined,
    getWorkflowState: async () => ({ ok: true, status: 'ready', workflows: [] }),
    getBrowserState: () => browserState(['tab-a']),
    hasPendingApproval: () => false,
    ...overrides,
  });
}

describe('V8 architecture and security gates', () => {
  it('keeps IPC typed and sender-checked with no generic command bus', () => {
    const ipc = readSrc('src/main/ipc.ts');
    const preload = readSrc('src/preload/app-preload.ts');
    assert.equal(ipc.includes('executeCommand'), false);
    assert.equal(ipc.includes('invoke(channel'), false);
    assert.equal(preload.includes('executeCommand'), false);
    assert.equal(preload.includes('invoke(channel'), false);
    assert.equal(preload.includes('browserCommand'), false);
    assert.equal(preload.includes('rawIpc'), false);
    assert.match(preload, /exposeInMainWorld\('aiNative'/);
    assert.match(preload, /getActivitySummary:/);
    assert.match(preload, /generateWorkflowDraft:/);
    assert.equal(preload.includes('activity.approve'), false);
    const website = readSrc('src/browser/electron-adapter.ts');
    const view = website.slice(
      website.indexOf('private createWebsiteView()'),
      website.indexOf('private createWebsiteView()') + 450,
    );
    assert.equal(view.includes('preload:'), false);
  });

  it('keeps WorkflowDraft generation off persistence and browser mutation', () => {
    const agent = readSrc('src/ai-native/workflow-draft-agent.ts');
    const controllerSrc = readSrc('src/main/ai-native-workflow-draft-controller.ts');
    for (const source of [agent, controllerSrc]) {
      for (const banned of [
        'workflows.create',
        'WorkflowProductController',
        'PersistentWorkflowRuntime',
        'runNow',
        'acknowledgeReview',
        '.click(',
        '.type(',
        '.navigate(',
      ]) {
        assert.equal(source.includes(banned), false, banned);
      }
    }
    assert.equal(controllerSrc.includes('BrowserAdapter'), false);
  });

  it('keeps multi-tab Ask read-only', () => {
    const agent = readSrc('src/ai-native/multi-tab-read-only-agent.ts');
    const controllerSrc = readSrc('src/main/ai-native-context-controller.ts');
    for (const source of [agent, controllerSrc]) {
      for (const banned of ['.click(', '.type(', 'decideApproval', 'startAutonomousTask', 'runNow']) {
        assert.equal(source.includes(banned), false, banned);
      }
    }
  });

  it('keeps Activity observational and approval on decideApproval', () => {
    const activity = readSrc('src/main/ai-native-activity-controller.ts');
    const popover = readSrc('src/app-ui/ActivitySummary.tsx');
    const ui = readSrc('src/app-ui/activity-ui-state.ts');
    for (const source of [activity, popover, ui]) {
      for (const banned of [
        'decideApproval',
        'runNow',
        'setEnabled',
        'acknowledgeReview',
        'pauseAutonomousTask',
        'replyToAutonomousTask',
      ]) {
        assert.equal(source.includes(banned), false, banned);
      }
    }
    const app = readSrc('src/app-ui/App.tsx');
    const panel = readSrc('src/app-ui/WorkflowsPanel.tsx');
    assert.match(app, /decideApproval\(\{ approvalId, decision \}\)/);
    assert.match(app, /generateWorkflowDraft/);
    assert.equal(app.includes('workflows.create'), false);
    assert.match(panel, /window\.workflows\.create/);
  });

  it('keeps the V7 workflow schema frozen and WorkflowDraft free of authority fields', () => {
    assert.equal(WORKFLOW_STORE_SCHEMA_VERSION, 1);
    assert.throws(
      () =>
        parseWorkflowDraft({
          name: 'Bad',
          objective: 'Bad',
          entryPoint: { kind: 'url', url: 'https://example.test' },
          trigger: { kind: 'manual' },
          enabled: true,
          taskId: 'task-1',
        }),
      WorkflowDraftValidationError,
    );
    const types = readSrc('src/shared/ai-native-types.ts');
    const draft = types.slice(types.indexOf('export interface WorkflowDraft'), types.indexOf('export interface AiNativeWorkflowDraftInput'));
    for (const banned of ['enabled', 'workflowId', 'approvalId', 'targetId', 'grant', 'taskId']) {
      assert.equal(draft.includes(banned), false, banned);
    }
  });

  it('injects a model runtime only from trusted main, defaulting to the Gateway', () => {
    const runtime = readSrc('src/main/ai-runtime.ts');
    const ipc = readSrc('src/main/ipc.ts');
    const preload = readSrc('src/preload/app-preload.ts');
    const main = readSrc('src/main/main.ts');
    assert.match(runtime, /options\?\.modelRuntime \?\? new AiSdkGatewayRuntime/);
    assert.match(main, /initializeAiRuntime\(adapter\)/);
    assert.equal(ipc.includes('modelRuntime'), false);
    assert.equal(preload.includes('modelRuntime'), false);
  });

  it('keeps the V8 Electron runner single-attempt', () => {
    const runner = readSrc('scripts/run-v8-electron-ai-native.cjs');
    assert.match(runner, /function runHarness\(\)/);
    assert.equal(runner.includes('for ('), false);
    assert.equal(runner.includes('while ('), false);
    assert.equal(runner.includes('retry'), false);
    assert.equal(runner.includes('attempt'), false);
    assert.equal((runner.match(/runHarness\(/g) ?? []).length, 2);
    assert.match(runner, /bundle-and-run-electron\.cjs/);
    assert.equal(runner.split('bundle-and-run-electron.cjs').length - 1, 1);
  });

  it('keeps ModelRequestLog metadata-only', () => {
    const log = readSrc('src/ai/request-log.ts');
    for (const banned of [
      'omnibox',
      'page context',
      'screenshot',
      'WorkflowDraft',
      'approvalId',
      'prompt',
    ]) {
      assert.equal(log.includes(banned), false, banned);
    }
    assert.match(log, /resolvedProviderModelId/);
    assert.match(log, /latencyMs/);
  });
});

describe('V8 Activity projection and attention', () => {
  it('orders approval above Delegate input and workflow review', () => {
    assert.deepEqual(
      chooseActivityAttention({
        approvalTabId: 'tab-b',
        delegateAwaitingUserInput: true,
        workflowReviewRequired: true,
      }),
      { kind: 'approval', tabId: 'tab-b' },
    );
  });

  it('does not double-count a workflow-owned V6 task as Delegate', async () => {
    const result = await controller({
      getSlotOwner: () => ({ kind: 'workflow', taskId: 'task-1' }),
      getTasks: () => [task('running-subgoal')],
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

  it('treats workflow-slot running fallback as transient and clears it after release', async () => {
    const acquired = await controller({
      getSlotOwner: () => ({ kind: 'workflow', taskId: 'task-1' }),
      getTasks: () => [task('running-subgoal')],
      getWorkflowState: async () => ({
        ok: true,
        status: 'ready',
        workflows: [workflow({ running: false })],
      }),
    }).getSummary();
    assert.equal(acquired.ok, true);
    if (acquired.ok) {
      assert.equal(acquired.summary.delegate.active, false);
      assert.equal(acquired.summary.workflows.runningCount, 1);
    }

    const established = await controller({
      getSlotOwner: () => ({ kind: 'workflow', taskId: 'task-1' }),
      getTasks: () => [task('running-subgoal')],
      getWorkflowState: async () => ({
        ok: true,
        status: 'ready',
        workflows: [workflow({ running: true })],
      }),
    }).getSummary();
    assert.equal(established.ok, true);
    if (established.ok) {
      assert.equal(established.summary.workflows.runningCount, 1);
    }

    const released = await controller({
      getSlotOwner: () => undefined,
      getTasks: () => [task('completed')],
      getWorkflowState: async () => ({
        ok: true,
        status: 'ready',
        workflows: [workflow({ running: false })],
      }),
    }).getSummary();
    assert.equal(released.ok, true);
    if (released.ok) {
      assert.equal(released.summary.workflows.runningCount, 0);
      assert.equal(released.summary.delegate.active, false);
    }
  });

  it('does not invent workflow running activity for storage-error or not-initialized', async () => {
    for (const status of ['storage-error', 'not-initialized'] as const) {
      const result = await controller({
        getSlotOwner: () => ({ kind: 'workflow', taskId: 'task-1' }),
        getWorkflowState: async () => ({ ok: true, status, workflows: [] }),
      }).getSummary();
      assert.equal(result.ok, true, status);
      if (result.ok) {
        assert.equal(result.summary.workflows.runningCount, 0, status);
      }
    }

    const failed = await controller({
      getSlotOwner: () => ({ kind: 'workflow', taskId: 'task-1' }),
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
});
