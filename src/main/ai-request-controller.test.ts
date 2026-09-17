import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from '../ai/model-errors';
import type { AgentAnswer, AgentAnswerOptions, AgentRequest } from '../ai/read-only-agent';
import type { TabId } from '../shared/browser-types';
import type { AiAnswerEvent } from '../shared/ai-types';
import { AiRequestController, type AiAskAgent } from './ai-request-controller';

const SECRET = 'provider-secret-body-DO-NOT-LEAK';
const TAB: TabId = 'tab-1';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class FakeAgent implements AiAskAgent {
  readonly cancelCalls: TabId[] = [];
  readonly clearCalls: TabId[] = [];
  clearAllCount = 0;
  impl: (
    request: AgentRequest,
    options?: AgentAnswerOptions,
  ) => Promise<AgentAnswer>;

  constructor(impl?: FakeAgent['impl']) {
    this.impl = impl ?? (async () => agentAnswer());
  }

  answer(request: AgentRequest, options?: AgentAnswerOptions): Promise<AgentAnswer> {
    return this.impl(request, options);
  }

  cancel(tabId: TabId): boolean {
    this.cancelCalls.push(tabId);
    return true;
  }

  clearConversation(tabId: TabId): void {
    this.clearCalls.push(tabId);
  }

  clearAllConversations(): void {
    this.clearAllCount += 1;
  }
}

function agentAnswer(overrides: Partial<AgentAnswer> = {}): AgentAnswer {
  return {
    text: 'Final answer',
    referencedTargets: ['target-should-not-leak'],
    alias: 'page-standard',
    truncatedContext: false,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function controllerOf(agent: FakeAgent) {
  const events: AiAnswerEvent[] = [];
  const controller = new AiRequestController({
    agent,
    emit: (event) => {
      events.push(event);
    },
  });
  return { controller, events };
}

describe('AiRequestController', () => {
  it('emits started, text, and finished events for a successful ask', async () => {
    const agent = new FakeAgent(async (_request, options) => {
      options?.onTextDelta?.('Hello');
      return agentAnswer({ text: 'Hello world', truncatedContext: true });
    });
    const { controller, events } = controllerOf(agent);

    const started = controller.startAsk(TAB, 'What is this?');
    assert.equal(started.ok, true);
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));

    assert.equal(events[0]?.type, 'answer-started');
    assert.equal(events[1]?.type, 'answer-text');
    assert.equal(events[1]?.type === 'answer-text' && events[1].delta, 'Hello');
    assert.equal(events[2]?.type, 'answer-finished');
    if (events[2]?.type === 'answer-finished') {
      assert.deepEqual(events[2].answer, { text: 'Hello world', truncatedContext: true });
      assert.equal('referencedTargets' in events[2].answer, false);
      assert.equal('alias' in events[2], false);
    }
    assert.equal(JSON.stringify(events).includes('target-should-not-leak'), false);
    assert.equal(JSON.stringify(events).includes('page-standard'), false);
  });

  it('maps REQUEST_CANCELLED to answer-cancelled', async () => {
    const agent = new FakeAgent(async () => {
      throw new ModelError('REQUEST_CANCELLED', 'cancelled internally');
    });
    const { controller, events } = controllerOf(agent);
    const started = controller.startAsk(TAB, 'Stop me?');
    assert.equal(started.ok, true);
    await waitUntil(() => events.some((event) => event.type === 'answer-cancelled'));
    assert.equal(events.at(-1)?.type, 'answer-cancelled');
    assert.equal(
      events.some((event) => event.type === 'answer-error'),
      false,
    );
  });

  it('sanitizes ModelError events and never leaks a secret cause', async () => {
    const agent = new FakeAgent(async () => {
      throw new ModelError('MODEL_RATE_LIMITED', `rate ${SECRET}`, { cause: SECRET });
    });
    const { controller, events } = controllerOf(agent);
    controller.startAsk(TAB, 'What is this?');
    await waitUntil(() => events.some((event) => event.type === 'answer-error'));
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(SECRET), false);
    const errorEvent = events.find((event) => event.type === 'answer-error');
    assert.equal(errorEvent?.type === 'answer-error' && errorEvent.error.code, 'MODEL_RATE_LIMITED');
    assert.equal(
      errorEvent?.type === 'answer-error' && errorEvent.error.message,
      'The AI service is temporarily rate limited.',
    );
  });

  it('maps unknown errors to AI_REQUEST_FAILED without leaking the message', async () => {
    const agent = new FakeAgent(async () => {
      throw new Error(SECRET);
    });
    const { controller, events } = controllerOf(agent);
    controller.startAsk(TAB, 'What is this?');
    await waitUntil(() => events.some((event) => event.type === 'answer-error'));
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(SECRET), false);
    const errorEvent = events.find((event) => event.type === 'answer-error');
    assert.equal(errorEvent?.type === 'answer-error' && errorEvent.error.code, 'AI_REQUEST_FAILED');
  });

  it('suppresses late events from a superseded ask', async () => {
    const first = new Deferred<AgentAnswer>();
    const second = new Deferred<AgentAnswer>();
    let firstDelta: ((text: string) => void) | undefined;
    let calls = 0;
    const agent = new FakeAgent(async (_request, options) => {
      calls += 1;
      if (calls === 1) {
        firstDelta = options?.onTextDelta;
        return first.promise;
      }
      return second.promise;
    });
    const { controller, events } = controllerOf(agent);

    const askA = controller.startAsk(TAB, 'Question A?');
    await waitUntil(() => events.some((event) => event.type === 'answer-started'));
    const askB = controller.startAsk(TAB, 'Question B?');
    await waitUntil(
      () => events.filter((event) => event.type === 'answer-started').length === 2,
    );

    firstDelta?.('late-A');
    first.resolve(agentAnswer({ text: 'from-A' }));
    second.resolve(agentAnswer({ text: 'from-B' }));
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));

    assert.equal(askA.ok && askB.ok, true);
    assert.equal(
      events.some((event) => event.type === 'answer-text' && event.delta === 'late-A'),
      false,
    );
    const finished = events.filter((event) => event.type === 'answer-finished');
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.type === 'answer-finished' && finished[0].askId, askB.ok ? askB.askId : '');
    assert.equal(
      events.some((event) => event.type === 'answer-cancelled' && askA.ok && event.askId === askA.askId),
      false,
    );
  });

  it('cancels only the current askId', async () => {
    const hold = new Deferred<AgentAnswer>();
    const agent = new FakeAgent(async () => hold.promise);
    const { controller } = controllerOf(agent);
    const askA = controller.startAsk(TAB, 'A?');
    const askB = controller.startAsk(TAB, 'B?');
    assert.equal(askA.ok && askB.ok, true);
    if (!askA.ok || !askB.ok) {
      return;
    }
    assert.deepEqual(controller.cancelAsk(TAB, askA.askId), { cancelled: false });
    assert.equal(agent.cancelCalls.length, 0);
    assert.deepEqual(controller.cancelAsk(TAB, askB.askId), { cancelled: true });
    assert.deepEqual(agent.cancelCalls, [TAB]);
    hold.reject(new ModelError('REQUEST_CANCELLED', 'cancelled'));
    await hold.promise.catch(() => undefined);
  });

  it('clears conversation, cancels the active ask, and suppresses late events', async () => {
    const hold = new Deferred<AgentAnswer>();
    let delta: ((text: string) => void) | undefined;
    const agent = new FakeAgent(async (_request, options) => {
      delta = options?.onTextDelta;
      return hold.promise;
    });
    const { controller, events } = controllerOf(agent);
    const started = controller.startAsk(TAB, 'Remember this?');
    await waitUntil(() => events.some((event) => event.type === 'answer-started'));
    const cleared = controller.clearConversation(TAB);
    assert.deepEqual(cleared, { ok: true });
    assert.deepEqual(agent.cancelCalls, [TAB]);
    assert.deepEqual(agent.clearCalls, [TAB]);
    delta?.('late-after-clear');
    hold.resolve(agentAnswer());
    await waitUntil(() => events.some((event) => event.type === 'conversation-cleared'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      events.some((event) => event.type === 'answer-text' || event.type === 'answer-finished'),
      false,
    );
    assert.equal(started.ok, true);
    assert.equal(
      events.some((event) => event.type === 'conversation-cleared' && event.reason === 'user'),
      true,
    );
  });
});
