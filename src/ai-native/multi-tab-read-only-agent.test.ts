import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildBrowserContextBundle } from './browser-context-builder';
import type { BrowserContextBundle } from './browser-context-types';
import { MultiTabReadOnlyAgent } from './multi-tab-read-only-agent';
import { ModelError } from '../ai/model-errors';
import type { ModelRuntime } from '../ai/model-runtime';
import type { ModelRequest, ModelResponse } from '../ai/model-types';
import type { BrowserState, TabId } from '../shared/browser-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';

const ROOT = path.resolve(__dirname, '..', '..');

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

function observation(tabId: TabId): PageObservation {
  return {
    observationId: `obs-${tabId}`,
    tabId,
    capturedAt: 1_700_000_000_000,
    document: {
      revision: `rev-${tabId}`,
      url: `https://example.com/${tabId}`,
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

class FakeRuntime implements ModelRuntime {
  readonly requests: ModelRequest[] = [];
  private readonly impl: (
    request: ModelRequest,
    options: { signal?: AbortSignal; onTextDelta?: (text: string) => void } | undefined,
    callIndex: number,
  ) => Promise<ModelResponse>;

  constructor(
    impl?: FakeRuntime['impl'] | ModelResponse | Array<ModelResponse | ModelError>,
  ) {
    if (typeof impl === 'function') {
      this.impl = impl;
    } else if (Array.isArray(impl)) {
      const scripted = impl;
      this.impl = async (_request, _options, callIndex) => {
        const next = scripted[callIndex - 1] ?? scripted[scripted.length - 1];
        if (next instanceof ModelError) {
          throw next;
        }
        return next ?? modelResponse();
      };
    } else {
      const response = impl ?? modelResponse();
      this.impl = async () => response;
    }
  }

  async generate(
    request: ModelRequest,
    options?: { signal?: AbortSignal; onTextDelta?: (text: string) => void },
  ): Promise<ModelResponse> {
    this.requests.push(request);
    return this.impl(request, options, this.requests.length);
  }
}

function modelResponse(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    text: 'Combined answer.',
    referencedTargets: ['target-tab-a', 'target-tab-b', 'invented-target'],
    resolvedProviderModelId: 'test/model',
    latencyMs: 1,
    ...overrides,
  };
}

async function bundleFor(tabIds: readonly TabId[]): Promise<BrowserContextBundle> {
  const source = {
    observePage: async (tabId: TabId) => observation(tabId),
  };
  const state: BrowserState = {
    activeTabId: tabIds[0] ?? 'tab-a',
    tabs: tabIds.map((id) => ({
      id,
      url: `https://example.com/${id}`,
      title: `Page ${id}`,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })),
  };
  return buildBrowserContextBundle({
    tabIds,
    getBrowserState: () => state,
    observationSource: source,
  });
}

function textOf(messages: ModelRequest['messages']): string {
  return JSON.stringify(messages);
}

describe('MultiTabReadOnlyAgent', () => {
  it('answers from one or several pages without returning referenced targets', async () => {
    const runtime = new FakeRuntime();
    const agent = new MultiTabReadOnlyAgent({
      modelRuntime: runtime,
    });
    const bundle = await bundleFor(['tab-a', 'tab-b']);

    const answer = await agent.answer({
      bundle,
      question: 'Compare these pages',
    });

    assert.equal(answer.text, 'Combined answer.');
    assert.equal(answer.alias, 'page-standard');
    assert.equal('referencedTargets' in answer, false);
    assert.equal(runtime.requests.length, 1);
    assert.match(textOf(runtime.requests[0]?.messages), /PAGE_CONTEXT tab tab-a/);
    assert.match(textOf(runtime.requests[0]?.messages), /PAGE_CONTEXT tab tab-b/);
    assert.equal(textOf(runtime.requests[0]?.messages).includes('image'), false);
  });

  it('uses bounded model fallback without re-observing', async () => {
    const runtime = new FakeRuntime([
      new ModelError('MODEL_UNAVAILABLE', 'down'),
      modelResponse({ text: 'Fallback answer.' }),
    ]);
    let observeCalls = 0;
    const source = {
      observePage: async (tabId: TabId) => {
        observeCalls += 1;
        return observation(tabId);
      },
    };
    const state: BrowserState = {
      activeTabId: 'tab-a',
      tabs: [
        {
          id: 'tab-a',
          url: 'https://example.com/tab-a',
          title: 'Page tab-a',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
    };
    const bundle = await buildBrowserContextBundle({
      tabIds: ['tab-a'],
      getBrowserState: () => state,
      observationSource: source,
    });
    const observedBeforeAnswer = observeCalls;
    const agent = new MultiTabReadOnlyAgent({
      modelRuntime: runtime,
    });

    const answer = await agent.answer({ bundle, question: 'What is this?' });
    assert.equal(answer.text, 'Fallback answer.');
    assert.equal(runtime.requests.length, 2);
    assert.equal(observeCalls, observedBeforeAnswer);
  });

  it('fails export-denied structured content for local-only privacy', async () => {
    const runtime = new FakeRuntime();
    const agent = new MultiTabReadOnlyAgent({
      modelRuntime: runtime,
    });
    const bundle = await bundleFor(['tab-a']);

    await assert.rejects(
      () =>
        agent.answer({
          bundle,
          question: 'What is this?',
          privacy: 'localOnly',
        }),
      (error: unknown) => error instanceof ModelError && error.code === 'MODEL_NOT_CONFIGURED',
    );
    assert.equal(runtime.requests.length, 0);
  });

  it('streams text deltas and supports cancellation', async () => {
    const runtime = new FakeRuntime(async (_request, options) => {
      options?.onTextDelta?.('Hel');
      options?.onTextDelta?.('lo');
      return modelResponse({ text: 'Hello' });
    });
    const agent = new MultiTabReadOnlyAgent({
      modelRuntime: runtime,
    });
    const bundle = await bundleFor(['tab-a']);
    const controller = new AbortController();
    const deltas: string[] = [];

    const answer = await agent.answer(
      { bundle, question: 'Hi', abortSignal: controller.signal },
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(answer.text, 'Hello');
  });

  it('aborts when cancelled before model generation', async () => {
    const runtime = new FakeRuntime();
    const agent = new MultiTabReadOnlyAgent({
      modelRuntime: runtime,
    });
    const bundle = await bundleFor(['tab-a']);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => agent.answer({ bundle, question: 'Hi', abortSignal: controller.signal }),
      (error: unknown) => error instanceof ModelError && error.code === 'REQUEST_CANCELLED',
    );
    assert.equal(runtime.requests.length, 0);
  });
});

describe('MultiTabReadOnlyAgent static authority review', () => {
  it('does not import mutation or conversation dependencies', () => {
    const source = readFileSync(
      path.join(ROOT, 'src/ai-native/multi-tab-read-only-agent.ts'),
      'utf8',
    );
    for (const forbidden of [
      'InteractionExecutor',
      'ExecuteExecutor',
      'PrepareActionService',
      'ApprovalManager',
      'ConversationStore',
      'PersistentWorkflowRuntime',
      'AutonomousTaskController',
      'BrowserAdapter',
      '.click(',
      '.navigate(',
    ]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
