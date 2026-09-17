import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractiveAgent } from './interactive-agent';
import type { InteractionModelRuntime } from './interaction-model-runtime';
import type { AgentModelOutput } from './interaction-output-schema';
import { MODEL_CATALOG } from './model-catalog';
import { ModelError } from './model-errors';
import type { ModelRequest } from './model-types';
import type { InteractionExecutionPort } from './interactive-agent';
import type { PageState, TabId } from '../shared/browser-types';
import { InteractionError } from '../shared/interaction-errors';
import type {
  BoundInteractionProposal,
  InteractionResult,
} from '../shared/interaction-types';
import { MAX_INTERACTION_TYPE_TEXT_LENGTH } from '../shared/interaction-types';
import type {
  ObservationNode,
  ObservePageOptions,
  PageObservation,
} from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';

const TAB: TabId = 'tab-1';

function pageState(): PageState {
  return {
    tabId: TAB,
    url: 'https://example.com/page',
    title: 'Example page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeObservationSource {
  readonly calls: Array<{ tabId: TabId; options?: ObservePageOptions }> = [];
  impl: (
    tabId: TabId,
    options: ObservePageOptions | undefined,
    callIndex: number,
  ) => Promise<PageObservation>;

  constructor(
    impl?: FakeObservationSource['impl'] | PageObservation | PageObservation[],
  ) {
    if (typeof impl === 'function') {
      this.impl = impl;
    } else if (Array.isArray(impl)) {
      const pages = impl;
      this.impl = async () => {
        const next = pages[this.calls.length - 1] ?? pages[pages.length - 1];
        if (!next) {
          throw new Error('No observation scripted');
        }
        return next;
      };
    } else {
      const page = impl ?? observation();
      this.impl = async () => page;
    }
  }

  async observePage(tabId: TabId, options?: ObservePageOptions): Promise<PageObservation> {
    this.calls.push({ tabId, options });
    return this.impl(tabId, options, this.calls.length);
  }
}

class FakeInteractionRuntime implements InteractionModelRuntime {
  readonly requests: ModelRequest[] = [];
  impl: (
    request: ModelRequest,
    options: { signal?: AbortSignal; onAnswerTextDelta?: (text: string) => void } | undefined,
    callIndex: number,
  ) => Promise<{ output: AgentModelOutput; resolvedProviderModelId: string; latencyMs: number }>;

  constructor(
    impl?: FakeInteractionRuntime['impl'] | AgentModelOutput,
  ) {
    if (typeof impl === 'function') {
      this.impl = impl;
    } else {
      const output =
        impl ??
        ({
          kind: 'answer',
          text: 'Done',
          referencedTargets: [],
        } satisfies AgentModelOutput);
      this.impl = async () => ({
        output,
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      });
    }
  }

  async generateInteraction(
    request: ModelRequest,
    options?: { signal?: AbortSignal; onAnswerTextDelta?: (text: string) => void },
  ) {
    this.requests.push(request);
    const result = await this.impl(request, options, this.requests.length);
    return {
      output: result.output,
      resolvedProviderModelId: result.resolvedProviderModelId,
      latencyMs: result.latencyMs,
    };
  }
}

class FakeExecutor implements InteractionExecutionPort {
  readonly calls: Array<{
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }> = [];
  impl: (
    input: {
      proposal: BoundInteractionProposal;
      observation: PageObservation;
      signal?: AbortSignal;
    },
    callIndex: number,
  ) => Promise<InteractionResult>;

  constructor(impl?: FakeExecutor['impl'] | InteractionResult) {
    if (typeof impl === 'function') {
      this.impl = impl;
    } else {
      const result =
        impl ??
        ({
          actionId: 'action-1',
          status: 'succeeded',
          pageState: pageState(),
        } satisfies InteractionResult);
      this.impl = async () => result;
    }
  }

  async execute(input: {
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): Promise<InteractionResult> {
    this.calls.push(input);
    return this.impl(input, this.calls.length);
  }
}

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

function observation(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    observationId: 'obs-1',
    tabId: TAB,
    capturedAt: 1_700_000_000_000,
    document: {
      revision: 'rev-a',
      url: 'https://example.com/page',
      title: 'Example page',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: {
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY: 0,
      deviceScaleFactor: 1,
    },
    nodes: [
      node({
        targetId: 'target-1',
        role: 'button',
        name: 'Save',
        tag: 'button',
        interactive: true,
      }),
      node({
        targetId: 'target-2',
        role: 'combobox',
        name: 'Color',
        tag: 'select',
        interactive: true,
        nativeOptions: [{ targetId: 'option-1', name: 'Red' }],
      }),
      node({
        targetId: 'target-hidden',
        role: 'button',
        name: 'Hidden',
        tag: 'button',
        interactive: true,
      }),
    ],
    stats: {
      sourceAxNodeCount: 3,
      sourceDomNodeCount: 3,
      emittedNodeCount: 3,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
    ...overrides,
  };
}

function agentOf(input: {
  pages?: FakeObservationSource;
  runtime?: FakeInteractionRuntime;
  executor?: FakeExecutor;
}) {
  const pages = input.pages ?? new FakeObservationSource();
  const runtime = input.runtime ?? new FakeInteractionRuntime();
  const executor = input.executor ?? new FakeExecutor();
  const agent = new InteractiveAgent({
    observationSource: pages,
    modelRuntime: runtime,
    interactionExecutor: executor,
    allowScreenshotExport: false,
    catalog: MODEL_CATALOG,
  });
  return { agent, pages, runtime, executor };
}

describe('InteractiveAgent', () => {
  it('returns an answer without invoking the executor', async () => {
    const runtime = new FakeInteractionRuntime({
      kind: 'answer',
      text: 'The page has a save button.',
      referencedTargets: ['target-1', 'not-exported', 'target-1'],
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    const result = await agent.interact({
      tabId: TAB,
      instruction: 'What is on this page?',
    });

    assert.equal(result.kind, 'answer');
    if (result.kind === 'answer') {
      assert.equal(result.text, 'The page has a save button.');
      assert.deepEqual(result.referencedTargets, ['target-1']);
    }
    assert.equal(executor.calls.length, 0);
    assert.equal(runtime.requests.length, 1);
  });

  it('binds a safe click proposal and invokes the executor once', async () => {
    const page = observation();
    const runtime = new FakeInteractionRuntime({
      kind: 'interaction',
      proposal: { kind: 'click', targetId: 'target-1' },
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({
      pages: new FakeObservationSource(page),
      runtime,
      executor,
    });

    const result = await agent.interact({
      tabId: TAB,
      instruction: 'Click save',
    });

    assert.equal(result.kind, 'interaction');
    assert.equal(executor.calls.length, 1);
    const call = executor.calls[0];
    assert.equal(call?.proposal.kind, 'click');
    assert.equal(call?.proposal.targetId, 'target-1');
    assert.equal(call?.proposal.tabId, page.tabId);
    assert.equal(call?.proposal.observationId, page.observationId);
    assert.equal(call?.proposal.documentRevision, page.document.revision);
    assert.equal(runtime.requests.length, 1);
  });

  it('rejects locally present but unexported targets before the executor', async () => {
    const runtime = new FakeInteractionRuntime({
      kind: 'interaction',
      proposal: { kind: 'click', targetId: 'not-exported' },
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    await assert.rejects(
      () => agent.interact({ tabId: TAB, instruction: 'Click hidden' }),
      (error: unknown) =>
        error instanceof InteractionError && error.code === 'TARGET_NOT_EXPORTED',
    );
    assert.equal(executor.calls.length, 0);
  });

  it('rejects invalid model authority fields before binding', async () => {
    const runtime = new FakeInteractionRuntime(async () => {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'invalid');
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    await assert.rejects(
      () => agent.interact({ tabId: TAB, instruction: 'Click save' }),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
    assert.equal(executor.calls.length, 0);
  });

  it('does not invoke the executor for invalid proposal bounds', async () => {
    const runtime = new FakeInteractionRuntime({
      kind: 'interaction',
      proposal: {
        kind: 'type',
        targetId: 'target-1',
        text: 'x'.repeat(MAX_INTERACTION_TYPE_TEXT_LENGTH + 1),
      },
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    await assert.rejects(
      () => agent.interact({ tabId: TAB, instruction: 'Type text' }),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
    assert.equal(executor.calls.length, 0);
  });

  it('returns executor denial without a second model call', async () => {
    const runtime = new FakeInteractionRuntime({
      kind: 'interaction',
      proposal: { kind: 'click', targetId: 'target-1' },
    });
    const executor = new FakeExecutor({
      actionId: 'action-1',
      status: 'denied',
      pageState: pageState(),
      errorCode: 'DEFERRED_TO_EXECUTE',
    });
    const { agent } = agentOf({ runtime, executor });

    const result = await agent.interact({ tabId: TAB, instruction: 'Buy now' });

    assert.equal(result.kind, 'interaction');
    if (result.kind === 'interaction') {
      assert.equal(result.result.status, 'denied');
      assert.equal(result.result.errorCode, 'DEFERRED_TO_EXECUTE');
    }
    assert.equal(runtime.requests.length, 1);
    assert.equal(executor.calls.length, 1);
  });

  it('returns executor failure without model retry', async () => {
    const pages = new FakeObservationSource();
    const runtime = new FakeInteractionRuntime({
      kind: 'interaction',
      proposal: { kind: 'click', targetId: 'target-1' },
    });
    const executor = new FakeExecutor({
      actionId: 'action-1',
      status: 'failed',
      pageState: pageState(),
      errorCode: 'TARGET_STALE',
    });
    const { agent } = agentOf({ pages, runtime, executor });

    const result = await agent.interact({ tabId: TAB, instruction: 'Click save' });

    assert.equal(result.kind, 'interaction');
    if (result.kind === 'interaction') {
      assert.equal(result.result.status, 'failed');
      assert.equal(result.result.errorCode, 'TARGET_STALE');
    }
    assert.equal(runtime.requests.length, 1);
    assert.equal(pages.calls.length, 1);
  });

  it('returns successful interaction without a second model inference', async () => {
    const runtime = new FakeInteractionRuntime({
      kind: 'interaction',
      proposal: { kind: 'click', targetId: 'target-1' },
    });
    const executor = new FakeExecutor({
      actionId: 'action-1',
      status: 'succeeded',
      pageState: pageState(),
      observation: observation({ observationId: 'obs-2' }),
    });
    const { agent, pages } = agentOf({ runtime, executor });

    const result = await agent.interact({ tabId: TAB, instruction: 'Click save' });

    assert.equal(result.kind, 'interaction');
    if (result.kind === 'interaction') {
      assert.equal(result.result.status, 'succeeded');
    }
    assert.equal(runtime.requests.length, 1);
    assert.equal(pages.calls.length, 1);
  });

  it('cancels before model without invoking the executor', async () => {
    const gate = new Deferred<void>();
    const runtime = new FakeInteractionRuntime(async (_request, options) => {
      await gate.promise;
      if (options?.signal?.aborted) {
        throw new ModelError('REQUEST_CANCELLED', 'cancelled');
      }
      return {
        output: { kind: 'answer', text: 'late', referencedTargets: [] },
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      };
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });
    const controller = new AbortController();

    const pending = agent.interact({
      tabId: TAB,
      instruction: 'Click save',
      abortSignal: controller.signal,
    });
    controller.abort();

    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof ModelError && error.code === 'REQUEST_CANCELLED',
    );
    assert.equal(executor.calls.length, 0);
  });

  it('retries observation only for PAGE_CHANGED_DURING_OBSERVATION', async () => {
    let observeCalls = 0;
    const pages = new FakeObservationSource(async () => {
      observeCalls += 1;
      if (observeCalls === 1) {
        throw new ObservationError(
          'PAGE_CHANGED_DURING_OBSERVATION',
          'Page changed during observation.',
        );
      }
      return observation();
    });
    const runtime = new FakeInteractionRuntime();
    const { agent } = agentOf({ pages, runtime });

    await agent.interact({ tabId: TAB, instruction: 'What is here?' });

    assert.equal(observeCalls, 2);
    assert.equal(runtime.requests.length, 1);
  });

  it('stores sanitized interaction summaries without target IDs', async () => {
    const runtime = new FakeInteractionRuntime({
      kind: 'interaction',
      proposal: { kind: 'click', targetId: 'target-1' },
    });
    const executor = new FakeExecutor({
      actionId: 'action-1',
      status: 'succeeded',
      pageState: pageState(),
    });
    const { agent } = agentOf({ runtime, executor });

    await agent.interact({ tabId: TAB, instruction: 'Click save' });
    await agent.interact({ tabId: TAB, instruction: 'What happened?' });

    const prior = runtime.requests[1]?.messages[1]?.content[0];
    assert.equal(prior?.type, 'text');
    if (prior?.type === 'text') {
      assert.match(prior.text, /\[interaction click succeeded\]/);
      assert.doesNotMatch(prior.text, /target-1/);
      assert.doesNotMatch(prior.text, /option-1/);
    }
  });
});
