import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildModelMessages,
  buildModelPageContext,
  estimateTextInputTokens,
} from './context-builder';
import { MODEL_CATALOG, type ModelCatalog } from './model-catalog';
import { ModelError, type ModelErrorCode } from './model-errors';
import type { ModelRuntime } from './model-runtime';
import type { ModelMessage, ModelRequest, ModelResponse } from './model-types';
import { ReadOnlyAgent } from './read-only-agent';
import type { TabId } from '../shared/browser-types';
import type {
  ObservationNode,
  ObservePageOptions,
  PageObservation,
} from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';

const SCREENSHOT_SENTINEL = 'SCREENSHOT_SENTINEL_BASE64_xyz';
const SECRET_LITERAL = 'fixture-secret-value';
const TAB: TabId = 'tab-1';

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

class FakeRuntime implements ModelRuntime {
  readonly requests: ModelRequest[] = [];
  impl: (
    request: ModelRequest,
    options: { signal?: AbortSignal; onTextDelta?: (text: string) => void } | undefined,
    callIndex: number,
  ) => Promise<ModelResponse>;

  constructor(impl?: FakeRuntime['impl'] | ModelResponse) {
    if (typeof impl === 'function') {
      this.impl = impl;
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
        targetId: 'target-a',
        role: 'button',
        name: 'Keep',
        tag: 'button',
        interactive: true,
      }),
      node({
        targetId: 'target-b',
        role: 'link',
        name: 'Also keep',
        tag: 'a',
        interactive: true,
      }),
    ],
    stats: {
      sourceAxNodeCount: 2,
      sourceDomNodeCount: 2,
      emittedNodeCount: 2,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
    ...overrides,
  };
}

function screenshot() {
  return {
    mimeType: 'image/jpeg' as const,
    width: 8,
    height: 8,
    encoding: 'base64' as const,
    data: SCREENSHOT_SENTINEL,
  };
}

function modelResponse(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    text: 'The page has a keep button.',
    referencedTargets: [],
    resolvedProviderModelId: 'test/model',
    latencyMs: 1,
    ...overrides,
  };
}

function agentOf(input: {
  pages?: FakeObservationSource;
  runtime?: FakeRuntime;
  allowScreenshotExport?: boolean;
  catalog?: ModelCatalog;
}) {
  const pages = input.pages ?? new FakeObservationSource();
  const runtime = input.runtime ?? new FakeRuntime();
  const agent = new ReadOnlyAgent({
    observationSource: pages,
    modelRuntime: runtime,
    allowScreenshotExport: input.allowScreenshotExport === true,
    catalog: input.catalog,
  });
  return { agent, pages, runtime };
}

function isModelError(code: ModelErrorCode) {
  return (error: unknown) => error instanceof ModelError && error.code === code;
}

function isObservationError(code: ObservationError['code']) {
  return (error: unknown) => error instanceof ObservationError && error.code === code;
}

function textOf(message: ModelMessage | undefined): string {
  if (!message) {
    return '';
  }
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function hasImagePart(messages: ModelMessage[]): boolean {
  return messages.some((message) => message.content.some((part) => part.type === 'image'));
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

describe('ReadOnlyAgent observation', () => {
  it('observes a fresh page for every successful question', async () => {
    const { agent, pages } = agentOf({
      pages: new FakeObservationSource([
        observation({ observationId: 'obs-1' }),
        observation({ observationId: 'obs-2' }),
      ]),
    });

    await agent.answer({ tabId: TAB, question: 'First?' });
    await agent.answer({ tabId: TAB, question: 'Second?' });

    assert.equal(pages.calls.length, 2);
    assert.deepEqual(pages.calls[0]?.options, { includeScreenshot: false });
    assert.deepEqual(pages.calls[1]?.options, { includeScreenshot: false });
  });

  it('retries once after PAGE_CHANGED_DURING_OBSERVATION', async () => {
    const pages = new FakeObservationSource(async (_tabId, _options, callIndex) => {
      if (callIndex === 1) {
        throw new ObservationError(
          'PAGE_CHANGED_DURING_OBSERVATION',
          'Stale observation',
        );
      }
      return observation();
    });
    const { agent, runtime } = agentOf({ pages });

    const answer = await agent.answer({ tabId: TAB, question: 'What is this?' });
    assert.equal(pages.calls.length, 2);
    assert.equal(runtime.requests.length, 1);
    assert.equal(answer.alias, 'page-standard');
  });

  it('surfaces the second stale observation error after one retry', async () => {
    const pages = new FakeObservationSource(async () => {
      throw new ObservationError('PAGE_CHANGED_DURING_OBSERVATION', 'Still stale');
    });
    const { agent, runtime } = agentOf({ pages });

    await assert.rejects(
      () => agent.answer({ tabId: TAB, question: 'What is this?' }),
      isObservationError('PAGE_CHANGED_DURING_OBSERVATION'),
    );
    assert.equal(pages.calls.length, 2);
    assert.equal(runtime.requests.length, 0);
  });

  it('does not retry CDP_UNAVAILABLE', async () => {
    const pages = new FakeObservationSource(async () => {
      throw new ObservationError('CDP_UNAVAILABLE', 'No debugger');
    });
    const { agent, runtime } = agentOf({ pages });

    await assert.rejects(
      () => agent.answer({ tabId: TAB, question: 'What is this?' }),
      isObservationError('CDP_UNAVAILABLE'),
    );
    assert.equal(pages.calls.length, 1);
    assert.equal(runtime.requests.length, 0);
  });
});

describe('ReadOnlyAgent conversation', () => {
  it('includes prior completed turns for the same document revision', async () => {
    const { agent, runtime } = agentOf({});
    await agent.answer({ tabId: TAB, question: 'First question?' });
    await agent.answer({ tabId: TAB, question: 'Second question?' });

    const second = runtime.requests[1];
    assert.ok(second);
    assert.equal(second.messages[0]?.role, 'system');
    assert.match(textOf(second.messages[1]), /<PRIOR_CONVERSATION>/);
    assert.equal(textOf(second.messages[1]).includes('First question?'), true);
    assert.equal(textOf(second.messages[2]), 'Second question?');
    assert.match(textOf(second.messages[3]), /<UNTRUSTED_PAGE_CONTENT>/);
    assert.equal(textOf(second.messages[1]).includes('UNTRUSTED_PAGE_CONTENT'), false);
    assert.equal(JSON.stringify(second.messages).includes('screenshot'), false);
  });

  it('clears history when the document revision changes', async () => {
    const pages = new FakeObservationSource([
      observation({ document: { ...observation().document, revision: 'rev-a' } }),
      observation({ document: { ...observation().document, revision: 'rev-b' } }),
    ]);
    const { agent, runtime } = agentOf({ pages });

    await agent.answer({ tabId: TAB, question: 'First question?' });
    await agent.answer({ tabId: TAB, question: 'Second question?' });

    const second = runtime.requests[1];
    assert.ok(second);
    assert.equal(textOf(second.messages[1]), 'Second question?');
    assert.equal(JSON.stringify(second.messages).includes('First question?'), false);
    assert.equal(JSON.stringify(second.messages).includes('PRIOR_CONVERSATION'), false);
  });

  it('does not commit cancelled or failed turns', async () => {
    let calls = 0;
    const runtime = new FakeRuntime(async () => {
      calls += 1;
      if (calls === 1) {
        throw new ModelError('MODEL_AUTH_FAILED', 'auth failed');
      }
      return modelResponse({ text: 'Recovered' });
    });
    const { agent } = agentOf({ runtime });

    await assert.rejects(
      () => agent.answer({ tabId: TAB, question: 'Will fail?' }),
      isModelError('MODEL_AUTH_FAILED'),
    );
    await agent.answer({ tabId: TAB, question: 'Follow up?' });
    assert.equal(JSON.stringify(runtime.requests[1]?.messages).includes('Will fail?'), false);
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
    await agent.answer({ tabId: TAB, question: 'Remember this?' });
    await assert.rejects(
      () => agent.answer({ tabId: TAB, question: 'Still there?' }),
      isObservationError('TAB_NOT_FOUND'),
    );
    await agent.answer({ tabId: TAB, question: 'New tab life?' });
    assert.equal(JSON.stringify(runtime.requests[1]?.messages).includes('Remember this?'), false);
  });
});

describe('ReadOnlyAgent export and routing', () => {
  it('does not call the model for localOnly privacy', async () => {
    const { agent, pages, runtime } = agentOf({});
    await assert.rejects(
      () =>
        agent.answer({
          tabId: TAB,
          question: 'What is this?',
          privacy: 'localOnly',
        }),
      isModelError('MODEL_NOT_CONFIGURED'),
    );
    assert.equal(pages.calls.length, 1);
    assert.equal(runtime.requests.length, 0);
  });

  it('omits screenshots for a normal text request even when the observation has one', async () => {
    const { agent, runtime } = agentOf({
      pages: new FakeObservationSource(observation({ screenshot: screenshot() })),
      allowScreenshotExport: true,
    });
    await agent.answer({ tabId: TAB, question: 'Summarize this page.' });
    const request = runtime.requests[0];
    assert.ok(request);
    assert.equal(hasImagePart(request.messages), false);
    assert.equal(JSON.stringify(request.messages).includes(SCREENSHOT_SENTINEL), false);
  });

  it('attaches a screenshot only when vision export is explicitly allowed', async () => {
    const { agent, runtime } = agentOf({
      pages: new FakeObservationSource(observation({ screenshot: screenshot() })),
      allowScreenshotExport: true,
    });
    await agent.answer({
      tabId: TAB,
      question: 'What is in this layout?',
      needsVision: true,
    });
    const request = runtime.requests[0];
    assert.ok(request);
    assert.equal(request.profile.alias, 'page-vision');
    assert.equal(hasImagePart(request.messages), true);
    const untrusted = request.messages[request.messages.length - 1];
    assert.equal(untrusted?.role, 'user');
    assert.equal(
      untrusted?.content.some((part) => part.type === 'image' && part.dataBase64 === SCREENSHOT_SENTINEL),
      true,
    );
    assert.equal(textOf(request.messages[0]).includes(SCREENSHOT_SENTINEL), false);
    assert.equal(textOf(request.messages[1]).includes(SCREENSHOT_SENTINEL), false);
  });

  it('omits screenshots when allowScreenshotExport is false', async () => {
    const { agent, runtime } = agentOf({
      pages: new FakeObservationSource(observation({ screenshot: screenshot() })),
      allowScreenshotExport: false,
    });
    await agent.answer({
      tabId: TAB,
      question: 'What is in this layout?',
      needsVision: true,
    });
    assert.equal(hasImagePart(runtime.requests[0]!.messages), false);
    assert.equal(JSON.stringify(runtime.requests[0]!.messages).includes(SCREENSHOT_SENTINEL), false);
  });

  it('does not fabricate a screenshot when the observation has none', async () => {
    const { agent, runtime } = agentOf({ allowScreenshotExport: true });
    await agent.answer({
      tabId: TAB,
      question: 'What is in this layout?',
      needsVision: true,
    });
    assert.equal(hasImagePart(runtime.requests[0]!.messages), false);
  });

  it('fails CONTEXT_TOO_LARGE when screenshot surcharge overflows the selected profile', async () => {
    const page = observation({ screenshot: screenshot() });
    const built = buildModelPageContext(page);
    const textTokens = estimateTextInputTokens(
      buildModelMessages({
        question: 'What is in this layout?',
        serializedPageContext: built.serialized,
        exportDecision: {
          structuredExportAllowed: true,
          screenshotExportAllowed: false,
          privacy: 'remoteAllowed',
        },
      }),
    );
    const maxOutputTokens = 16;
    const catalog: ModelCatalog = {
      ...MODEL_CATALOG,
      'page-vision': {
        gateway: MODEL_CATALOG['page-vision'].gateway,
        profile: {
          ...MODEL_CATALOG['page-vision'].profile,
          contextWindowTokens: textTokens + maxOutputTokens + 4,
          maxOutputTokens,
        },
      },
    };
    const { agent, runtime } = agentOf({
      pages: new FakeObservationSource(page),
      allowScreenshotExport: true,
      catalog,
    });

    await assert.rejects(
      () =>
        agent.answer({
          tabId: TAB,
          question: 'What is in this layout?',
          needsVision: true,
        }),
      isModelError('CONTEXT_TOO_LARGE'),
    );
    assert.equal(runtime.requests.length, 0);
  });

  it('sends compact page context rather than the raw observation', async () => {
    const page = observation({
      nodes: [
        node({
          targetId: 'secret-box',
          role: 'textbox',
          name: SECRET_LITERAL,
          value: SECRET_LITERAL,
          text: SECRET_LITERAL,
          tag: 'input',
          interactive: true,
          states: { secret: true },
        }),
      ],
    });
    const { agent, runtime } = agentOf({ pages: new FakeObservationSource(page) });
    await agent.answer({ tabId: TAB, question: 'What is on the page?' });
    const payload = JSON.stringify(runtime.requests[0]?.messages);
    assert.equal(payload.includes('obs-1'), false);
    assert.equal(payload.includes('frame-1'), false);
    assert.equal(payload.includes(SECRET_LITERAL), false);
    assert.match(textOf(runtime.requests[0]?.messages.at(-1)), /<UNTRUSTED_PAGE_CONTENT>/);
  });
});

describe('ReadOnlyAgent model fallback', () => {
  for (const code of [
    'MODEL_UNAVAILABLE',
    'MODEL_RATE_LIMITED',
    'MODEL_OUTPUT_INVALID',
    'MODEL_TIMEOUT',
  ] as const) {
    it(`falls back after ${code} when no text was streamed`, async () => {
      const runtime = new FakeRuntime(async (_request, _options, callIndex) => {
        if (callIndex === 1) {
          throw new ModelError(code, code);
        }
        return modelResponse({ text: 'Fallback answer' });
      });
      const { agent } = agentOf({ runtime });
      const answer = await agent.answer({ tabId: TAB, question: 'What is this?' });
      assert.equal(runtime.requests.length, 2);
      assert.notEqual(runtime.requests[0]?.requestId, runtime.requests[1]?.requestId);
      assert.equal(runtime.requests[0]?.profile.alias, 'page-standard');
      assert.equal(runtime.requests[1]?.profile.alias, 'page-deep');
      assert.equal(answer.alias, 'page-deep');
      assert.equal(answer.text, 'Fallback answer');
    });
  }

  it('does not fall back after MODEL_AUTH_FAILED', async () => {
    const runtime = new FakeRuntime(async () => {
      throw new ModelError('MODEL_AUTH_FAILED', 'auth');
    });
    const { agent } = agentOf({ runtime });
    await assert.rejects(
      () => agent.answer({ tabId: TAB, question: 'What is this?' }),
      isModelError('MODEL_AUTH_FAILED'),
    );
    assert.equal(runtime.requests.length, 1);
  });

  it('does not fall back after MODEL_REQUEST_FAILED', async () => {
    const runtime = new FakeRuntime(async () => {
      throw new ModelError('MODEL_REQUEST_FAILED', 'generic');
    });
    const { agent } = agentOf({ runtime });
    await assert.rejects(
      () => agent.answer({ tabId: TAB, question: 'What is this?' }),
      isModelError('MODEL_REQUEST_FAILED'),
    );
    assert.equal(runtime.requests.length, 1);
  });

  it('does not fall back after REQUEST_CANCELLED', async () => {
    const runtime = new FakeRuntime(async () => {
      throw new ModelError('REQUEST_CANCELLED', 'cancelled by runtime');
    });
    const { agent } = agentOf({ runtime });
    await assert.rejects(
      () => agent.answer({ tabId: TAB, question: 'What is this?' }),
      isModelError('REQUEST_CANCELLED'),
    );
    assert.equal(runtime.requests.length, 1);
  });

  it('does not fall back after partial streamed text', async () => {
    const deltas: string[] = [];
    const runtime = new FakeRuntime(async (_request, options) => {
      options?.onTextDelta?.('Partial');
      throw new ModelError('MODEL_UNAVAILABLE', 'unavailable after stream');
    });
    const { agent } = agentOf({ runtime });
    await assert.rejects(
      () =>
        agent.answer(
          { tabId: TAB, question: 'What is this?' },
          { onTextDelta: (text) => deltas.push(text) },
        ),
      isModelError('MODEL_UNAVAILABLE'),
    );
    assert.deepEqual(deltas, ['Partial']);
    assert.equal(runtime.requests.length, 1);
  });

  it('never makes a third model attempt', async () => {
    const runtime = new FakeRuntime(async () => {
      throw new ModelError('MODEL_UNAVAILABLE', 'still down');
    });
    const { agent } = agentOf({ runtime });
    await assert.rejects(
      () => agent.answer({ tabId: TAB, question: 'What is this?' }),
      isModelError('MODEL_UNAVAILABLE'),
    );
    assert.equal(runtime.requests.length, 2);
  });
});

describe('ReadOnlyAgent answers', () => {
  it('filters invented and duplicate target ids without failing the answer', async () => {
    const runtime = new FakeRuntime(
      modelResponse({
        referencedTargets: ['target-a', 'invented-x', 'target-a', 'target-b'],
      }),
    );
    const { agent } = agentOf({ runtime });
    const answer = await agent.answer({ tabId: TAB, question: 'What can I click?' });
    assert.deepEqual(answer.referencedTargets, ['target-a', 'target-b']);
    assert.equal(answer.truncatedContext, false);
  });

  it('uses the successful fallback alias in the answer', async () => {
    const runtime = new FakeRuntime(async (_request, _options, callIndex) => {
      if (callIndex === 1) {
        throw new ModelError('MODEL_UNAVAILABLE', 'primary down');
      }
      return modelResponse({ text: 'From fallback' });
    });
    const { agent } = agentOf({ runtime });
    const answer = await agent.answer({ tabId: TAB, question: 'Analyze this.', taskClass: 'page_question' });
    assert.equal(answer.alias, 'page-deep');
    assert.equal(answer.text, 'From fallback');
  });
});

describe('ReadOnlyAgent cancellation and supersession', () => {
  it('lets B wait and then observe after A is cancelled during observation', async () => {
    const releaseA = new Deferred();
    let observeCalls = 0;
    const pages = new FakeObservationSource(async () => {
      observeCalls += 1;
      if (observeCalls === 1) {
        await releaseA.promise;
      }
      return observation();
    });
    const { agent, runtime } = agentOf({ pages });

    const aPromise = agent.answer({ tabId: TAB, question: 'Question A?' });
    await waitUntil(() => observeCalls === 1);
    const bPromise = agent.answer({ tabId: TAB, question: 'Question B?' });
    releaseA.resolve();

    await assert.rejects(aPromise, isModelError('REQUEST_CANCELLED'));
    const bAnswer = await bPromise;
    assert.equal(bAnswer.text, 'The page has a keep button.');
    assert.equal(observeCalls, 2);
    assert.equal(runtime.requests.length, 1);
    assert.equal(textOf(runtime.requests[0]?.messages[1]), 'Question B?');
  });

  it('supersedes B when C arrives while A is still observing', async () => {
    const releaseA = new Deferred();
    let observeCalls = 0;
    const pages = new FakeObservationSource(async () => {
      observeCalls += 1;
      if (observeCalls === 1) {
        await releaseA.promise;
      }
      return observation();
    });
    const { agent, runtime } = agentOf({ pages });

    const aPromise = agent.answer({ tabId: TAB, question: 'Question A?' });
    await waitUntil(() => observeCalls === 1);
    const bPromise = agent.answer({ tabId: TAB, question: 'Question B?' });
    const cPromise = agent.answer({ tabId: TAB, question: 'Question C?' });
    releaseA.resolve();

    await assert.rejects(aPromise, isModelError('REQUEST_CANCELLED'));
    await assert.rejects(bPromise, isModelError('REQUEST_CANCELLED'));
    const cAnswer = await cPromise;
    assert.equal(cAnswer.text, 'The page has a keep button.');
    assert.equal(observeCalls, 2);
    assert.equal(runtime.requests.length, 1);
    assert.equal(textOf(runtime.requests[0]?.messages[1]), 'Question C?');
  });

  it('does not forward superseded deltas from A after B takes ownership', async () => {
    const aInGenerate = new Deferred();
    const releaseA = new Deferred();
    const aDeltas: string[] = [];
    const bDeltas: string[] = [];
    const runtime = new FakeRuntime(async (_request, options, callIndex) => {
      if (callIndex === 1) {
        options?.onTextDelta?.('A1');
        aInGenerate.resolve();
        await releaseA.promise;
        options?.onTextDelta?.('late-A');
        return modelResponse({ text: 'from-A' });
      }
      options?.onTextDelta?.('B1');
      return modelResponse({ text: 'from-B' });
    });
    const { agent } = agentOf({ runtime });

    const aPromise = agent.answer(
      { tabId: TAB, question: 'Question A?' },
      { onTextDelta: (text) => aDeltas.push(text) },
    );
    await aInGenerate.promise;
    const bPromise = agent.answer(
      { tabId: TAB, question: 'Question B?' },
      { onTextDelta: (text) => bDeltas.push(text) },
    );
    await Promise.resolve();
    releaseA.resolve();

    await assert.rejects(aPromise, isModelError('REQUEST_CANCELLED'));
    const bAnswer = await bPromise;
    assert.deepEqual(aDeltas, ['A1']);
    assert.deepEqual(bDeltas, ['B1']);
    assert.equal(bAnswer.text, 'from-B');
  });

  it('cancels an in-flight ask without calling the model after observation returns', async () => {
    const releaseObserve = new Deferred();
    const pages = new FakeObservationSource(async () => {
      await releaseObserve.promise;
      return observation();
    });
    const abort = new AbortController();
    const { agent, runtime } = agentOf({ pages });
    const pending = agent.answer({
      tabId: TAB,
      question: 'Stop me?',
      abortSignal: abort.signal,
    });
    await waitUntil(() => pages.calls.length === 1);
    abort.abort();
    releaseObserve.resolve();
    await assert.rejects(pending, isModelError('REQUEST_CANCELLED'));
    assert.equal(runtime.requests.length, 0);
  });

  it('does not start work when the external signal is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const { agent, pages, runtime } = agentOf({});
    await assert.rejects(
      () =>
        agent.answer({
          tabId: TAB,
          question: 'Already stopped?',
          abortSignal: abort.signal,
        }),
      isModelError('REQUEST_CANCELLED'),
    );
    assert.equal(pages.calls.length, 0);
    assert.equal(runtime.requests.length, 0);
  });

  it('cancel aborts the active ask without clearing completed history', async () => {
    const releaseObserve = new Deferred();
    let observeCalls = 0;
    const pages = new FakeObservationSource(async () => {
      observeCalls += 1;
      if (observeCalls === 2) {
        await releaseObserve.promise;
      }
      return observation();
    });
    const { agent, runtime } = agentOf({ pages });
    await agent.answer({ tabId: TAB, question: 'Remember me?' });
    const pending = agent.answer({ tabId: TAB, question: 'Interrupt me?' });
    await waitUntil(() => observeCalls === 2);
    assert.equal(agent.cancel(TAB), true);
    releaseObserve.resolve();
    await assert.rejects(pending, isModelError('REQUEST_CANCELLED'));
    await agent.answer({ tabId: TAB, question: 'Still remembered?' });
    assert.equal(JSON.stringify(runtime.requests.at(-1)?.messages).includes('Remember me?'), true);
    assert.equal(JSON.stringify(runtime.requests.at(-1)?.messages).includes('Interrupt me?'), false);
  });

  it('allows different tabs to run concurrently', async () => {
    const releaseTab1 = new Deferred();
    const pages = new FakeObservationSource(async (tabId) => {
      if (tabId === 'tab-1') {
        await releaseTab1.promise;
      }
      return observation({ tabId });
    });
    const { agent, runtime } = agentOf({ pages });
    const first = agent.answer({ tabId: 'tab-1', question: 'Tab one?' });
    const second = agent.answer({ tabId: 'tab-2', question: 'Tab two?' });
    const secondAnswer = await second;
    assert.equal(secondAnswer.text, 'The page has a keep button.');
    assert.equal(runtime.requests.length, 1);
    releaseTab1.resolve();
    await first;
    assert.equal(runtime.requests.length, 2);
  });
});
