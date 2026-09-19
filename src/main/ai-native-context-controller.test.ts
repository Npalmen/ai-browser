import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MultiTabReadOnlyAgent } from '../ai-native/multi-tab-read-only-agent';
import type { BrowserState, TabId } from '../shared/browser-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';
import type { ModelRuntime } from '../ai/model-runtime';
import type { ModelRequest, ModelResponse } from '../ai/model-types';
import { AiNativeContextController } from './ai-native-context-controller';

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

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeRuntime implements ModelRuntime {
  readonly requests: ModelRequest[] = [];
  private readonly impl: (
    request: ModelRequest,
    options: { signal?: AbortSignal; onTextDelta?: (text: string) => void } | undefined,
  ) => Promise<ModelResponse>;

  constructor(impl?: FakeRuntime['impl'] | ModelResponse) {
    if (typeof impl === 'function') {
      this.impl = impl;
    } else {
      const response = impl ?? {
        text: 'Answer text',
        referencedTargets: [],
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      };
      this.impl = async () => response;
    }
  }

  async generate(
    request: ModelRequest,
    options?: { signal?: AbortSignal; onTextDelta?: (text: string) => void },
  ): Promise<ModelResponse> {
    this.requests.push(request);
    return this.impl(request, options);
  }
}

function browserState(tabIds: readonly TabId[]): BrowserState {
  return {
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
}

function mutateOnControllerModelBoundary(
  state: BrowserState,
  mutate: (state: BrowserState) => void,
): () => BrowserState {
  return () => {
    const stack = new Error().stack ?? '';
    if (stack.includes('assertSelectedContextStillCurrent')) {
      mutate(state);
    }
    return state;
  };
}

function controllerOf(input: {
  runtime?: FakeRuntime;
  observe?: (tabId: TabId) => Promise<PageObservation>;
  getBrowserState?: () => BrowserState;
}) {
  const events: Array<{ type: string; askId?: string }> = [];
  const runtime = input.runtime ?? new FakeRuntime();
  const observationSource = {
    observePage: input.observe ?? (async (tabId: TabId) => observation(tabId)),
  };
  const controller = new AiNativeContextController({
    observationSource,
    multiTabAgent: new MultiTabReadOnlyAgent({
      modelRuntime: runtime,
    }),
    getBrowserState: input.getBrowserState ?? (() => browserState(['tab-a', 'tab-b'])),
    emit: (event) => {
      events.push(event);
    },
  });
  return { controller, events, runtime };
}

async function waitFor(
  events: Array<{ type: string; askId?: string }>,
  type: string,
  askId?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (events.some((event) => event.type === type && (askId === undefined || event.askId === askId))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

describe('AiNativeContextController', () => {
  it('starts one active ask and emits started, text, and finished events', async () => {
    const { controller, events } = controllerOf({
      runtime: new FakeRuntime(async (_request, options) => {
        options?.onTextDelta?.('A');
        return {
          text: 'Answer text',
          referencedTargets: [],
          resolvedProviderModelId: 'test/model',
          latencyMs: 1,
        };
      }),
    });

    const started = controller.startAsk({
      question: 'What is here?',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-started', started.askId);
    await waitFor(events, 'context-answer-finished', started.askId);
    assert.equal(events.some((event) => event.type === 'context-answer-text'), true);
    assert.equal(events.at(-1)?.type, 'context-answer-finished');
  });

  it('supersedes the previous ask when a new one starts', async () => {
    const gate = new Deferred<void>();
    const { controller, events } = controllerOf({
      observe: async (tabId) => {
        await gate.promise;
        return observation(tabId);
      },
    });

    const first = controller.startAsk({
      question: 'First',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    const second = controller.startAsk({
      question: 'Second',
      context: { kind: 'selected-tabs', tabIds: ['tab-b'] },
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }

    gate.resolve();
    await waitFor(events, 'context-answer-finished', second.askId);
    assert.equal(
      events.filter((event) => event.type === 'context-answer-cancelled' && event.askId === first.askId)
        .length,
      1,
    );
    assert.equal(
      events.some(
        (event) => event.type === 'context-answer-finished' && event.askId === first.askId,
      ),
      false,
    );
  });

  it('cancels streaming ask without finishing', async () => {
    const { controller, events } = controllerOf({
      runtime: new FakeRuntime(async (_request, options) => {
        options?.onTextDelta?.('partial');
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          text: 'late',
          referencedTargets: [],
          resolvedProviderModelId: 'test/model',
          latencyMs: 1,
        };
      }),
    });

    const started = controller.startAsk({
      question: 'Cancel me',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-text', started.askId);
    controller.cancelContextAsk(started.askId);
    await waitFor(events, 'context-answer-cancelled', started.askId);
    assert.equal(
      events.some(
        (event) => event.type === 'context-answer-finished' && event.askId === started.askId,
      ),
      false,
    );
  });

  it('fails missing tabs with error and no finished event', async () => {
    const { controller, events, runtime } = controllerOf({
      getBrowserState: () => browserState(['tab-a']),
    });

    const started = controller.startAsk({
      question: 'Compare',
      context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-missing'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-error', started.askId);
    assert.equal(runtime.requests.length, 0);
    assert.equal(
      events.some((event) => event.type === 'context-answer-finished' && event.askId === started.askId),
      false,
    );
  });

  it('dispose aborts pending work without later events', async () => {
    const gate = new Deferred<void>();
    const { controller, events } = controllerOf({
      observe: async (tabId) => {
        await gate.promise;
        return observation(tabId);
      },
    });

    const started = controller.startAsk({
      question: 'Dispose me',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(started.ok, true);
    controller.dispose();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      events.some((event) => event.type === 'context-answer-finished'),
      false,
    );
  });

  it('maps observation failures to safe context errors', async () => {
    const { controller, events, runtime } = controllerOf({
      observe: async () => {
        throw new ObservationError('CDP_UNAVAILABLE', 'down');
      },
    });

    const started = controller.startAsk({
      question: 'What?',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-error', started.askId);
    assert.equal(runtime.requests.length, 0);
  });

  it('fails without a model call when a later selected tab navigates during context build', async () => {
    const state = browserState(['tab-a', 'tab-b']);
    const { controller, events, runtime } = controllerOf({
      getBrowserState: () => state,
      observe: async (tabId) => {
        if (tabId === 'tab-a') {
          const later = state.tabs.find((tab) => tab.id === 'tab-b');
          if (later) {
            later.url = 'https://example.test/replaced';
          }
        }
        return observation(tabId);
      },
    });

    const started = controller.startAsk({
      question: 'Compare',
      context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-error', started.askId);
    const errorEvent = events.find((event) => event.type === 'context-answer-error');
    assert.equal((errorEvent as { error?: { code?: string } } | undefined)?.error?.code, 'AI_NATIVE_CONTEXT_UNAVAILABLE');
    assert.equal(runtime.requests.length, 0);
    assert.equal(
      events.some((event) => event.type === 'context-answer-finished' && event.askId === started.askId),
      false,
    );
  });

  it('fails without a model call when a previously observed tab navigates before model export', async () => {
    const state = browserState(['tab-a', 'tab-b']);
    const { controller, events, runtime } = controllerOf({
      getBrowserState: () => state,
      observe: async (tabId) => {
        if (tabId === 'tab-b') {
          const earlier = state.tabs.find((tab) => tab.id === 'tab-a');
          if (earlier) {
            earlier.url = 'https://example.test/replaced';
          }
        }
        return observation(tabId);
      },
    });

    const started = controller.startAsk({
      question: 'Compare',
      context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-error', started.askId);
    assert.equal(runtime.requests.length, 0);
  });

  it('cancels during context build without turning abort into a context error', async () => {
    const gate = new Deferred<void>();
    const { controller, events, runtime } = controllerOf({
      observe: async (tabId) => {
        await gate.promise;
        return observation(tabId);
      },
    });

    const started = controller.startAsk({
      question: 'Cancel during observe',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-started', started.askId);
    controller.cancelContextAsk(started.askId);
    gate.resolve();
    await waitFor(events, 'context-answer-cancelled', started.askId);
    assert.equal(runtime.requests.length, 0);
    assert.equal(
      events.some((event) => event.type === 'context-answer-error' && event.askId === started.askId),
      false,
    );
  });

  it('fails without a model call when a selected tab navigates after bundle build', async () => {
    const state = browserState(['tab-a']);
    const { controller, events, runtime } = controllerOf({
      getBrowserState: mutateOnControllerModelBoundary(state, (live) => {
        const tab = live.tabs.find((candidate) => candidate.id === 'tab-a');
        if (tab) {
          tab.url = 'https://example.test/replaced';
        }
      }),
    });

    const started = controller.startAsk({
      question: 'What is here?',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-error', started.askId);
    const errorEvent = events.find((event) => event.type === 'context-answer-error');
    assert.equal(
      (errorEvent as { error?: { code?: string } } | undefined)?.error?.code,
      'AI_NATIVE_CONTEXT_UNAVAILABLE',
    );
    assert.equal(runtime.requests.length, 0);
    assert.equal(
      events.some((event) => event.type === 'context-answer-finished' && event.askId === started.askId),
      false,
    );
  });

  it('fails without a model call when a selected tab closes after bundle build', async () => {
    const state = browserState(['tab-a']);
    const { controller, events, runtime } = controllerOf({
      getBrowserState: mutateOnControllerModelBoundary(state, (live) => {
        live.tabs = live.tabs.filter((tab) => tab.id !== 'tab-a');
      }),
    });

    const started = controller.startAsk({
      question: 'What is here?',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-error', started.askId);
    assert.equal(runtime.requests.length, 0);
  });

  it('fails without a model call when a selected tab becomes about:blank after bundle build', async () => {
    const state = browserState(['tab-a']);
    const { controller, events, runtime } = controllerOf({
      getBrowserState: mutateOnControllerModelBoundary(state, (live) => {
        const tab = live.tabs.find((candidate) => candidate.id === 'tab-a');
        if (tab) {
          tab.url = 'about:blank';
        }
      }),
    });

    const started = controller.startAsk({
      question: 'What is here?',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    await waitFor(events, 'context-answer-error', started.askId);
    assert.equal(runtime.requests.length, 0);
  });
});

describe('ai-runtime composition', () => {
  it('wires context controller alongside existing single-tab runtime', () => {
    const source = readFileSync(path.join(ROOT, 'src/main/ai-runtime.ts'), 'utf8');
    assert.match(source, /new MultiTabReadOnlyAgent/);
    assert.match(source, /new AiNativeContextController/);
    assert.match(source, /contextController\?\.dispose/);
    assert.match(source, /getAiNativeContextController/);
    assert.match(source, /modelRuntime: gatewayRuntime/);
  });

  it('revalidates the selected snapshot immediately before invoking the multi-tab agent', () => {
    const source = readFileSync(path.join(ROOT, 'src/main/ai-native-context-controller.ts'), 'utf8');
    const runAsk = source.slice(source.indexOf('private async runAsk'));
    const cancelIndex = runAsk.indexOf('if (this.isStaleAsk(askId, controller))');
    const validateIndex = runAsk.indexOf('this.assertSelectedContextStillCurrent(bundle)');
    const answerIndex = runAsk.indexOf('const answer = await this.multiTabAgent.answer(');
    assert.ok(cancelIndex >= 0);
    assert.ok(validateIndex > cancelIndex);
    assert.ok(answerIndex > validateIndex);
    const between = runAsk.slice(validateIndex, answerIndex);
    assert.equal(between.includes('await '), false);
  });
});
