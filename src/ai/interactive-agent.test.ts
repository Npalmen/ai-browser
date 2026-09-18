import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractiveAgent } from './interactive-agent';
import type { InteractionModelRuntime } from './interaction-model-runtime';
import type { AgentModelOutput } from './interaction-output-schema';
import { MODEL_CATALOG } from './model-catalog';
import { ModelError, type ModelErrorCode } from './model-errors';
import type { ModelRequest } from './model-types';
import type { InteractionExecutionPort } from './interaction-execution-port';
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

function isModelError(code: ModelErrorCode) {
  return (error: unknown) => error instanceof ModelError && error.code === code;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
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

  it('rejects streamed answer text followed by a final interaction proposal', async () => {
    const runtime = new FakeInteractionRuntime(async (_request, options) => {
      options?.onAnswerTextDelta?.('Visible answer');
      return {
        output: {
          kind: 'interaction',
          proposal: { kind: 'click', targetId: 'target-1' },
        },
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      };
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    await assert.rejects(
      () => agent.interact({ tabId: TAB, instruction: 'Click save' }),
      isModelError('MODEL_OUTPUT_INVALID'),
    );
    assert.equal(runtime.requests.length, 1);
    assert.equal(executor.calls.length, 0);
  });

  it('does not fall back after streamed answer text switches to interaction', async () => {
    const runtime = new FakeInteractionRuntime(async (_request, options, callIndex) => {
      if (callIndex === 1) {
        options?.onAnswerTextDelta?.('Visible answer');
        return {
          output: {
            kind: 'interaction',
            proposal: { kind: 'click', targetId: 'target-1' },
          },
          resolvedProviderModelId: 'test/model',
          latencyMs: 1,
        };
      }
      return {
        output: { kind: 'answer', text: 'Fallback answer', referencedTargets: [] },
        resolvedProviderModelId: 'test/fallback',
        latencyMs: 1,
      };
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    await assert.rejects(
      () => agent.interact({ tabId: TAB, instruction: 'Click save' }),
      isModelError('MODEL_OUTPUT_INVALID'),
    );
    assert.equal(runtime.requests.length, 1);
    assert.equal(executor.calls.length, 0);
  });

  it('falls back after MODEL_UNAVAILABLE when no answer text was streamed', async () => {
    const runtime = new FakeInteractionRuntime(async (_request, _options, callIndex) => {
      if (callIndex === 1) {
        throw new ModelError('MODEL_UNAVAILABLE', 'unavailable');
      }
      return {
        output: { kind: 'answer', text: 'Fallback answer', referencedTargets: [] },
        resolvedProviderModelId: 'test/fallback',
        latencyMs: 1,
      };
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    const result = await agent.interact({ tabId: TAB, instruction: 'What is here?' });

    assert.equal(result.kind, 'answer');
    if (result.kind === 'answer') {
      assert.equal(result.text, 'Fallback answer');
      assert.equal(result.alias, 'page-deep');
    }
    assert.equal(runtime.requests.length, 2);
    assert.equal(runtime.requests[0]?.profile.alias, 'page-standard');
    assert.equal(runtime.requests[1]?.profile.alias, 'page-deep');
    assert.equal(executor.calls.length, 0);
  });

  it('does not fall back after partial streamed answer text before model failure', async () => {
    const runtime = new FakeInteractionRuntime(async (_request, options) => {
      options?.onAnswerTextDelta?.('Partial answer');
      throw new ModelError('MODEL_UNAVAILABLE', 'unavailable after stream');
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    await assert.rejects(
      () => agent.interact({ tabId: TAB, instruction: 'What is here?' }),
      isModelError('MODEL_UNAVAILABLE'),
    );
    assert.equal(runtime.requests.length, 1);
    assert.equal(executor.calls.length, 0);
  });

  it('does not fall back after MODEL_AUTH_FAILED', async () => {
    const runtime = new FakeInteractionRuntime(async () => {
      throw new ModelError('MODEL_AUTH_FAILED', 'auth failed');
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    await assert.rejects(
      () => agent.interact({ tabId: TAB, instruction: 'What is here?' }),
      isModelError('MODEL_AUTH_FAILED'),
    );
    assert.equal(runtime.requests.length, 1);
    assert.equal(executor.calls.length, 0);
  });

  it('cancels during an active model call without invoking the executor', async () => {
    const modelStarted = new Deferred<void>();
    const releaseModel = new Deferred<void>();
    const runtime = new FakeInteractionRuntime(async (_request, options) => {
      modelStarted.resolve();
      await releaseModel.promise;
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
      instruction: 'What is here?',
      abortSignal: controller.signal,
    });
    await modelStarted.promise;
    controller.abort();
    releaseModel.resolve();

    await assert.rejects(pending, isModelError('REQUEST_CANCELLED'));
    assert.equal(runtime.requests.length, 1);
    assert.equal(executor.calls.length, 0);
  });

  it('lets the latest same-tab request cancel the previous model flow', async () => {
    const aInGenerate = new Deferred<void>();
    const releaseA = new Deferred<void>();
    const runtime = new FakeInteractionRuntime(async (_request, options, callIndex) => {
      if (callIndex === 1) {
        aInGenerate.resolve();
        await releaseA.promise;
        if (options?.signal?.aborted) {
          throw new ModelError('REQUEST_CANCELLED', 'cancelled');
        }
        return {
          output: { kind: 'answer', text: 'from-A', referencedTargets: [] },
          resolvedProviderModelId: 'test/model',
          latencyMs: 1,
        };
      }
      return {
        output: { kind: 'answer', text: 'from-B', referencedTargets: [] },
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      };
    });
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    const aPromise = agent.interact({ tabId: TAB, instruction: 'Question A?' });
    await aInGenerate.promise;
    const bPromise = agent.interact({ tabId: TAB, instruction: 'Question B?' });
    releaseA.resolve();

    await assert.rejects(aPromise, isModelError('REQUEST_CANCELLED'));
    const bResult = await bPromise;

    assert.equal(bResult.kind, 'answer');
    if (bResult.kind === 'answer') {
      assert.equal(bResult.text, 'from-B');
    }
    assert.equal(runtime.requests.length, 2);
    assert.equal(
      runtime.requests[1]?.messages[1]?.content[0]?.type === 'text'
        ? runtime.requests[1].messages[1].content[0].text
        : '',
      'Question B?',
    );
    assert.equal(executor.calls.length, 0);
  });

  it('re-parses malicious runtime output with forbidden authority fields', async () => {
    const runtime = new FakeInteractionRuntime(async () => ({
      output: {
        kind: 'interaction',
        proposal: {
          kind: 'click',
          targetId: 'target-1',
          tabId: 'attacker-tab',
        },
      } as AgentModelOutput,
      resolvedProviderModelId: 'test/model',
      latencyMs: 1,
    }));
    const executor = new FakeExecutor();
    const { agent } = agentOf({ runtime, executor });

    await assert.rejects(
      () =>
        agent.interact({
          tabId: TAB,
          instruction: 'Analyze this page.',
          taskClass: 'page_analysis',
        }),
      isModelError('MODEL_OUTPUT_INVALID'),
    );
    assert.equal(runtime.requests.length, 1);
    assert.equal(runtime.requests[0]?.profile.alias, 'page-deep');
    assert.equal(executor.calls.length, 0);
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

  it('returns approval-required without committing a denial or leaking tokens', async () => {
    const pages = new FakeObservationSource();
    const runtime = new FakeInteractionRuntime({
      kind: 'interaction',
      proposal: { kind: 'click', targetId: 'target-1' },
    });
    const agent = new InteractiveAgent({
      observationSource: pages,
      modelRuntime: runtime,
      interactionExecutor: {
        async execute() {
          return { status: 'approval-required' };
        },
      },
      allowScreenshotExport: false,
      catalog: MODEL_CATALOG,
    });

    const result = await agent.interact({ tabId: TAB, instruction: 'Buy now' });
    assert.equal(result.kind, 'interaction');
    if (result.kind === 'interaction') {
      assert.deepEqual(result.result, { status: 'approval-required' });
    }

    await agent.interact({ tabId: TAB, instruction: 'What happened?' });
    const serialized = JSON.stringify([result, runtime.requests]);
    assert.equal(serialized.includes('[interaction click denied]'), false);
    for (const token of ['approvalId', 'preparedActionId', 'executionId', 'ExecuteGrant']) {
      assert.equal(JSON.stringify(result).includes(token), false, token);
    }
  });

  it('clears conversation when observation reports TAB_NOT_FOUND', async () => {
    let calls = 0;
    const pages = new FakeObservationSource(async () => {
      calls += 1;
      if (calls === 2) {
        throw new ObservationError('TAB_NOT_FOUND', 'gone');
      }
      return observation();
    });
    const { agent, runtime } = agentOf({ pages });
    await agent.interact({ tabId: TAB, instruction: 'Remember this?' });
    await assert.rejects(
      () => agent.interact({ tabId: TAB, instruction: 'Still there?' }),
      (error: unknown) =>
        error instanceof ObservationError && error.code === 'TAB_NOT_FOUND',
    );
    await agent.interact({ tabId: TAB, instruction: 'New tab life?' });
    assert.equal(JSON.stringify(runtime.requests[1]?.messages).includes('Remember this?'), false);
  });

  it('does not carry prior-revision conversation into a new document revision', async () => {
    const pages = new FakeObservationSource(async (_tabId, _options, callIndex) =>
      observation({
        observationId: `obs-${callIndex}`,
        document: {
          revision: callIndex === 1 ? 'rev-a' : 'rev-b',
          url: 'https://example.com/page',
          title: 'Example page',
          loading: false,
          mainFrameId: 'frame-1',
        },
      }),
    );
    const { agent, runtime } = agentOf({ pages });
    await agent.interact({ tabId: TAB, instruction: 'First revision question?' });
    await agent.interact({ tabId: TAB, instruction: 'Second revision question?' });
    assert.equal(
      JSON.stringify(runtime.requests[1]?.messages).includes('First revision question?'),
      false,
    );
  });
});
