import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ModelError } from '../ai/model-errors';
import type { ModelRequest } from '../ai/model-types';
import { WorkflowDraftAgent } from '../ai-native/workflow-draft-agent';
import type { WorkflowDraftRuntime, WorkflowDraftRuntimeResponse } from '../ai-native/workflow-draft-runtime';
import type { WorkflowDraft } from '../shared/ai-native-types';
import type { BrowserState, TabId } from '../shared/browser-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';
import { AiNativeWorkflowDraftController } from './ai-native-workflow-draft-controller';

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-09-19T10:00:00.000Z');

function node(
  overrides: Partial<ObservationNode> & Pick<ObservationNode, 'role'>,
): ObservationNode {
  return {
    frameId: 'frame-1',
    interactive: false,
    visible: true,
    inViewport: true,
    ...overrides,
  };
}

function observation(tabId: TabId, url = `https://example.test/${tabId}`): PageObservation {
  return {
    observationId: `obs-${tabId}`,
    tabId,
    capturedAt: 1_700_000_000_000,
    document: {
      revision: `rev-${tabId}`,
      url,
      title: `Page ${tabId}`,
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, deviceScaleFactor: 1 },
    nodes: [
      node({
        targetId: `target-${tabId}`,
        role: 'button',
        name: 'Keep',
        tag: 'button',
        interactive: true,
      }),
    ],
    stats: {
      sourceAxNodeCount: 1,
      sourceDomNodeCount: 1,
      emittedNodeCount: 1,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
  };
}

function validDraft(): WorkflowDraft {
  return {
    name: 'Status check',
    objective: 'Check the page.',
    entryPoint: { kind: 'url', url: 'https://example.test/status' },
    trigger: { kind: 'manual' },
  };
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeDraftRuntime implements WorkflowDraftRuntime {
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly impl: (
      request: ModelRequest,
      options?: { signal?: AbortSignal },
    ) => Promise<WorkflowDraftRuntimeResponse> = async () => ({
      draft: validDraft(),
      resolvedProviderModelId: 'test/model',
      latencyMs: 1,
    }),
  ) {}

  async generateWorkflowDraft(
    request: ModelRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowDraftRuntimeResponse> {
    this.requests.push(request);
    if (options?.signal?.aborted) {
      throw new ModelError('REQUEST_CANCELLED', 'cancelled');
    }
    return this.impl(request, options);
  }
}

function httpState(tabIds: readonly TabId[], activeTabId = tabIds[0]): BrowserState {
  return {
    activeTabId: activeTabId ?? 'tab-a',
    tabs: tabIds.map((id) => ({
      id,
      url: `https://example.test/${id}`,
      title: `Page ${id}`,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })),
  };
}

function blankState(tabId = 'tab-blank'): BrowserState {
  return {
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        url: 'about:blank',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
  };
}

function controllerOf(options: {
  runtime?: FakeDraftRuntime;
  state: BrowserState;
  observe?: (tabId: TabId) => Promise<PageObservation>;
}) {
  const runtime = options.runtime ?? new FakeDraftRuntime();
  const observed: TabId[] = [];
  const observeOptions: Array<{ tabId: TabId; includeScreenshot?: boolean }> = [];
  const observationSource = {
    observePage: async (tabId: TabId, observeOptionsInput?: { includeScreenshot?: boolean }) => {
      observed.push(tabId);
      observeOptions.push({ tabId, includeScreenshot: observeOptionsInput?.includeScreenshot });
      if (options.observe) {
        return options.observe(tabId);
      }
      const tab = options.state.tabs.find((candidate) => candidate.id === tabId);
      return observation(tabId, tab?.url);
    },
  };
  const agent = new WorkflowDraftAgent({ runtime });
  const controller = new AiNativeWorkflowDraftController({
    observationSource,
    agent,
    getBrowserState: () => options.state,
    now: () => NOW,
    defaultTimeZone: () => 'Europe/Stockholm',
  });
  return { controller, runtime, observed, observeOptions };
}

describe('AiNativeWorkflowDraftController', () => {
  it('builds current http(s) context and returns a draft', async () => {
    const { controller, runtime, observed, observeOptions } = controllerOf({ state: httpState(['tab-a']) });
    const result = await controller.generate({
      instruction: 'Every weekday at 08:00 check this page for outages',
      context: { kind: 'current-tab', tabId: 'tab-a' },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.draft.name, 'Status check');
      assert.equal('workflowId' in result.draft, false);
    }
    assert.deepEqual(observed, ['tab-a']);
    assert.equal(observeOptions[0]?.includeScreenshot, false);
    assert.equal(runtime.requests.length, 1);
    assert.equal(
      runtime.requests[0]?.messages.some((message) =>
        message.content.some((part) => part.type === 'image'),
      ),
      false,
    );
  });

  it('observes selected tabs in user order', async () => {
    const { controller, observed } = controllerOf({ state: httpState(['tab-a', 'tab-b']) });
    const result = await controller.generate({
      instruction: 'Compare these pages daily',
      context: { kind: 'selected-tabs', tabIds: ['tab-b', 'tab-a'] },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(observed, ['tab-b', 'tab-a']);
  });

  it('skips observation for current about:blank and still generates from the instruction', async () => {
    const { controller, runtime, observed } = controllerOf({ state: blankState() });
    const result = await controller.generate({
      instruction: 'Every weekday at 08:00 check https://example.test/status',
      context: { kind: 'current-tab', tabId: 'tab-blank' },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(observed, []);
    assert.equal(runtime.requests.length, 1);
    const texts = runtime.requests[0]?.messages
      .flatMap((message) => message.content.filter((part) => part.type === 'text').map((part) => part.text))
      .join('\n');
    assert.match(texts ?? '', /USER_INSTRUCTION/);
    assert.equal((texts ?? '').includes('UNTRUSTED_PAGE_CONTEXT'), false);
  });

  it('fails stale selected context with zero model calls', async () => {
    const state = httpState(['tab-a', 'tab-b']);
    const runtime = new FakeDraftRuntime();
    const { controller } = controllerOf({
      runtime,
      state,
      observe: async (tabId) => {
        if (tabId === 'tab-a') {
          const tab = state.tabs.find((candidate) => candidate.id === 'tab-b');
          if (tab) {
            tab.url = 'https://example.test/replaced';
          }
        }
        return observation(tabId, `https://example.test/${tabId}`);
      },
    });
    const result = await controller.generate({
      instruction: 'Check these pages',
      context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_UNAVAILABLE');
    }
    assert.equal(runtime.requests.length, 0);
  });

  it('supersedes an in-flight generation', async () => {
    const firstStarted = new Deferred<void>();
    const firstOutput = new Deferred<WorkflowDraftRuntimeResponse>();
    let calls = 0;
    const runtime = new FakeDraftRuntime(async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        return firstOutput.promise;
      }
      return {
        draft: { ...validDraft(), name: 'Second' },
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      };
    });
    const { controller } = controllerOf({ runtime, state: blankState() });
    const first = controller.generate({
      instruction: 'First draft',
      context: { kind: 'current-tab', tabId: 'tab-blank' },
    });
    await firstStarted.promise;
    const second = await controller.generate({
      instruction: 'Second draft',
      context: { kind: 'current-tab', tabId: 'tab-blank' },
    });
    firstOutput.resolve({
      draft: { ...validDraft(), name: 'First' },
      resolvedProviderModelId: 'test/model',
      latencyMs: 1,
    });
    const firstResult = await first;
    assert.equal(firstResult.ok, false);
    if (!firstResult.ok) {
      assert.equal(firstResult.error.code, 'AI_NATIVE_REQUEST_CANCELLED');
    }
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.draft.name, 'Second');
    }
  });

  it('dispose cancels in-flight generation', async () => {
    const pending = new Deferred<WorkflowDraftRuntimeResponse>();
    const runtime = new FakeDraftRuntime(async () => pending.promise);
    const { controller } = controllerOf({ runtime, state: blankState() });
    const resultPromise = controller.generate({
      instruction: 'Create a workflow',
      context: { kind: 'current-tab', tabId: 'tab-blank' },
    });
    controller.dispose();
    pending.resolve({
      draft: validDraft(),
      resolvedProviderModelId: 'test/model',
      latencyMs: 1,
    });
    const result = await resultPromise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_REQUEST_CANCELLED');
    }
    const afterDispose = await controller.generate({
      instruction: 'Create a workflow',
      context: { kind: 'current-tab', tabId: 'tab-blank' },
    });
    assert.equal(afterDispose.ok, false);
    if (!afterDispose.ok) {
      assert.equal(afterDispose.error.code, 'AI_NATIVE_NOT_AVAILABLE');
    }
  });

  it('rejects invalid about:blank drafts that lack a start URL', async () => {
    const runtime = new FakeDraftRuntime(async () => ({
      draft: {
        name: 'Check this site',
        objective: 'Every weekday at 08:00 check this site',
        entryPoint: { kind: 'url', url: 'about:blank' },
        trigger: {
          kind: 'schedule',
          schedule: {
            kind: 'recurring-weekly',
            timeZone: 'Europe/Stockholm',
            hour: 8,
            minute: 0,
            daysOfWeek: [1, 2, 3, 4, 5],
          },
        },
      } as unknown as WorkflowDraft,
      resolvedProviderModelId: 'test/model',
      latencyMs: 1,
    }));
    const { controller } = controllerOf({ runtime, state: blankState() });
    const result = await controller.generate({
      instruction: 'Every weekday at 08:00 check this site',
      context: { kind: 'current-tab', tabId: 'tab-blank' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_DRAFT_INVALID');
    }
  });

  it('maps invalid model output to AI_NATIVE_DRAFT_INVALID', async () => {
    const runtime = new FakeDraftRuntime(async () => ({
      draft: {
        ...validDraft(),
        enabled: true,
        taskId: 'task-1',
      } as unknown as WorkflowDraft,
      resolvedProviderModelId: 'test/model',
      latencyMs: 1,
    }));
    const { controller } = controllerOf({ runtime, state: blankState() });
    const result = await controller.generate({
      instruction: 'Create a workflow',
      context: { kind: 'current-tab', tabId: 'tab-blank' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_DRAFT_INVALID');
    }
  });

  it('does not import persistence or mutation surfaces', () => {
    const files = [
      'src/main/ai-native-workflow-draft-controller.ts',
      'src/ai-native/workflow-draft.ts',
      'src/ai-native/workflow-draft-agent.ts',
      'src/ai-native/workflow-draft-runtime.ts',
      'src/ai-native/workflow-draft-system-prompt.ts',
    ];
    for (const relative of files) {
      const source = readFileSync(path.join(ROOT, relative), 'utf8');
      for (const banned of [
        'WorkflowProductController',
        'DurableWorkflowCoordinator',
        'WorkflowStore',
        'WorkflowOccurrenceRunner',
        'InteractionExecutor',
        'ExecuteExecutor',
        'ApprovalManager',
        'AutonomousTaskController',
      ]) {
        assert.equal(source.includes(banned), false, `${relative} ${banned}`);
      }
    }
  });
});
