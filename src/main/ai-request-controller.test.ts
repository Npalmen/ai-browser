import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { InteractiveAgentResult } from '../ai/interactive-agent';
import { ModelError } from '../ai/model-errors';
import type { AgentAnswer, AgentAnswerOptions, AgentRequest } from '../ai/read-only-agent';
import type { TabId } from '../shared/browser-types';
import type { InteractionResult } from '../shared/interaction-types';
import type { AiAnswerEvent } from '../shared/ai-types';
import {
  AiRequestController,
  type AiInteractionAgent,
  type AiReadAgent,
} from './ai-request-controller';

const SECRET = 'provider-secret-body-DO-NOT-LEAK';
const TYPED_SECRET = 'V3_UI_TYPED_SECRET_DO_NOT_LEAK';
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

class FakeReadAgent implements AiReadAgent {
  readonly answerCalls: AgentRequest[] = [];
  readonly cancelCalls: TabId[] = [];
  readonly clearCalls: TabId[] = [];
  clearAllCount = 0;
  impl: (
    request: AgentRequest,
    options?: AgentAnswerOptions,
  ) => Promise<AgentAnswer>;

  constructor(impl?: FakeReadAgent['impl']) {
    this.impl = impl ?? (async () => agentAnswer());
  }

  answer(request: AgentRequest, options?: AgentAnswerOptions): Promise<AgentAnswer> {
    this.answerCalls.push(request);
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

class FakeInteractionAgent implements AiInteractionAgent {
  readonly interactCalls: Array<{ tabId: TabId; instruction: string }> = [];
  readonly cancelCalls: TabId[] = [];
  readonly clearCalls: TabId[] = [];
  clearAllCount = 0;
  impl: (
    request: { tabId: TabId; instruction: string },
    options?: { onAnswerTextDelta?: (text: string) => void },
  ) => Promise<InteractiveAgentResult>;

  constructor(impl?: FakeInteractionAgent['impl']) {
    this.impl =
      impl ??
      (async () => ({
        kind: 'answer',
        text: 'Interaction answer',
        referencedTargets: [],
        alias: 'page-standard',
        truncatedContext: false,
      }));
  }

  interact(
    request: { tabId: TabId; instruction: string },
    options?: { onAnswerTextDelta?: (text: string) => void },
  ): Promise<InteractiveAgentResult> {
    this.interactCalls.push(request);
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

function pageState() {
  return {
    tabId: TAB,
    url: 'https://example.com/page',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

function interactionResult(overrides: Partial<InteractionResult> = {}): InteractionResult {
  return {
    actionId: 'action-should-not-leak',
    status: 'succeeded',
    pageState: pageState(),
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

function controllerOf(readAgent: FakeReadAgent, interactiveAgent: FakeInteractionAgent) {
  const events: AiAnswerEvent[] = [];
  const controller = new AiRequestController({
    readAgent,
    interactiveAgent,
    emit: (event) => {
      events.push(event);
    },
  });
  return { controller, events };
}

describe('AiRequestController', () => {
  it('exposes a read-only Ask/Act activity snapshot without question text', () => {
    const { controller } = controllerOf(new FakeReadAgent(), new FakeInteractionAgent());
    controller.startAsk(TAB, 'Secret question that must not leak', 'read');
    const snapshot = controller.getActivitySnapshot();
    assert.deepEqual(snapshot, [{ tabId: TAB, mode: 'read' }]);
    assert.equal(JSON.stringify(snapshot).includes('Secret question'), false);
    assert.equal(JSON.stringify(snapshot).includes('askId'), false);
  });

  it('routes read mode to ReadOnlyAgent only', async () => {
    const readAgent = new FakeReadAgent();
    const interactiveAgent = new FakeInteractionAgent();
    const { controller, events } = controllerOf(readAgent, interactiveAgent);

    controller.startAsk(TAB, 'What is this?', 'read');
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));

    assert.equal(readAgent.answerCalls.length, 1);
    assert.equal(interactiveAgent.interactCalls.length, 0);
  });

  it('routes interact mode to InteractiveAgent only', async () => {
    const readAgent = new FakeReadAgent();
    const interactiveAgent = new FakeInteractionAgent();
    const { controller, events } = controllerOf(readAgent, interactiveAgent);

    controller.startAsk(TAB, 'Click save', 'interact');
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));

    assert.equal(readAgent.answerCalls.length, 0);
    assert.equal(interactiveAgent.interactCalls.length, 1);
    assert.equal(events[0]?.type, 'interaction-started');
  });

  it('emits started, text, and finished events for a successful read ask', async () => {
    const readAgent = new FakeReadAgent(async (_request, options) => {
      options?.onTextDelta?.('Hello');
      return agentAnswer({ text: 'Hello world', truncatedContext: true });
    });
    const { controller, events } = controllerOf(readAgent, new FakeInteractionAgent());

    const started = controller.startAsk(TAB, 'What is this?', 'read');
    assert.equal(started.ok, true);
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));

    assert.equal(events[0]?.type, 'answer-started');
    assert.equal(events[1]?.type, 'answer-text');
    assert.equal(events[2]?.type, 'answer-finished');
  });

  it('maps interaction success to interaction-completed without leaking handles', async () => {
    const interactiveAgent = new FakeInteractionAgent(async () => ({
      kind: 'interaction',
      alias: 'page-standard',
      truncatedContext: true,
      result: interactionResult({
        observation: {
          observationId: 'obs-secret',
          tabId: TAB,
          capturedAt: 1,
          document: {
            revision: 'rev-secret',
            url: 'https://example.com',
            title: 'Secret',
            loading: false,
            mainFrameId: 'frame-secret',
          },
          viewport: {
            width: 800,
            height: 600,
            scrollX: 0,
            scrollY: 0,
            deviceScaleFactor: 1,
          },
          nodes: [{ targetId: 'target-secret', frameId: 'frame-secret', role: 'button', interactive: true, visible: true, inViewport: true }],
          stats: {
            sourceAxNodeCount: 1,
            sourceDomNodeCount: 1,
            emittedNodeCount: 1,
            truncated: false,
            redactedValueCount: 0,
            frameCount: 1,
            crossOriginFrameCount: 0,
          },
        },
      }),
    }));
    const { controller, events } = controllerOf(new FakeReadAgent(), interactiveAgent);
    controller.startAsk(TAB, 'Click save', 'interact');
    await waitUntil(() => events.some((event) => event.type === 'interaction-completed'));

    const serialized = JSON.stringify(events);
    for (const token of [
      'target-secret',
      'obs-secret',
      'frame-secret',
      'action-should-not-leak',
      'proposal',
      'grant',
      'pageState',
      'observation',
    ]) {
      assert.equal(serialized.includes(token), false, token);
    }
  });

  it('maps policy denial to interaction-denied', async () => {
    const interactiveAgent = new FakeInteractionAgent(async () => ({
      kind: 'interaction',
      alias: 'page-standard',
      truncatedContext: false,
      result: interactionResult({
        status: 'denied',
        errorCode: 'DEFERRED_TO_EXECUTE',
      }),
    }));
    const { controller, events } = controllerOf(new FakeReadAgent(), interactiveAgent);
    controller.startAsk(TAB, 'Buy now', 'interact');
    await waitUntil(() => events.some((event) => event.type === 'interaction-denied'));

    const denied = events.find((event) => event.type === 'interaction-denied');
    assert.equal(denied?.type === 'interaction-denied' && denied.error.code, 'DEFERRED_TO_EXECUTE');
    assert.equal(
      denied?.type === 'interaction-denied' && denied.error.message,
      'This action is not available without additional approval.',
    );
    assert.equal(events.some((event) => event.type === 'interaction-failed'), false);
  });

  it('maps runtime failure to interaction-failed', async () => {
    const interactiveAgent = new FakeInteractionAgent(async () => ({
      kind: 'interaction',
      alias: 'page-standard',
      truncatedContext: false,
      result: interactionResult({
        status: 'failed',
        errorCode: 'TARGET_STALE',
      }),
    }));
    const { controller, events } = controllerOf(new FakeReadAgent(), interactiveAgent);
    controller.startAsk(TAB, 'Click save', 'interact');
    await waitUntil(() => events.some((event) => event.type === 'interaction-failed'));

    const failed = events.find((event) => event.type === 'interaction-failed');
    assert.equal(failed?.type === 'interaction-failed' && failed.error.code, 'TARGET_STALE');
    assert.equal(events.some((event) => event.type === 'interaction-denied'), false);
  });

  it('supports interaction-started followed by answer-finished for answer-only interact results', async () => {
    const interactiveAgent = new FakeInteractionAgent(async (_request, options) => {
      options?.onAnswerTextDelta?.('Hel');
      return {
        kind: 'answer',
        text: 'No action needed',
        referencedTargets: [],
        alias: 'page-standard',
        truncatedContext: false,
      };
    });
    const { controller, events } = controllerOf(new FakeReadAgent(), interactiveAgent);
    controller.startAsk(TAB, 'What is here?', 'interact');
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));

    assert.equal(events[0]?.type, 'interaction-started');
    assert.equal(events.some((event) => event.type === 'answer-text'), true);
    assert.equal(events.at(-1)?.type, 'answer-finished');
    assert.equal(events.some((event) => event.type === 'interaction-completed'), false);
  });

  it('cancels read then interact cross-mode and suppresses late read events', async () => {
    const readInGenerate = new Deferred<void>();
    const releaseRead = new Deferred<void>();
    const readAgent = new FakeReadAgent(async (_request, options) => {
      readInGenerate.resolve();
      await releaseRead.promise;
      options?.onTextDelta?.('late-read');
      return agentAnswer({ text: 'from-read' });
    });
    const interactiveAgent = new FakeInteractionAgent(async () => ({
      kind: 'answer',
      text: 'from-interact',
      referencedTargets: [],
      alias: 'page-standard',
      truncatedContext: false,
    }));
    const { controller, events } = controllerOf(readAgent, interactiveAgent);

    controller.startAsk(TAB, 'Read question?', 'read');
    await readInGenerate.promise;
    controller.startAsk(TAB, 'Click save', 'interact');
    releaseRead.resolve();
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));

    assert.deepEqual(readAgent.cancelCalls, [TAB]);
    assert.equal(interactiveAgent.interactCalls.length, 1);
    assert.equal(
      events.some((event) => event.type === 'answer-text' && event.delta === 'late-read'),
      false,
    );
    const finished = events.find((event) => event.type === 'answer-finished');
    assert.equal(finished?.type === 'answer-finished' && finished.answer.text, 'from-interact');
  });

  it('cancels interact then read cross-mode', async () => {
    const interactInGenerate = new Deferred<void>();
    const releaseInteract = new Deferred<void>();
    const readAgent = new FakeReadAgent(async () => agentAnswer({ text: 'from-read' }));
    const interactiveAgent = new FakeInteractionAgent(async (_request, options) => {
      interactInGenerate.resolve();
      await releaseInteract.promise;
      options?.onAnswerTextDelta?.('late-interact');
      return {
        kind: 'answer',
        text: 'from-interact',
        referencedTargets: [],
        alias: 'page-standard',
        truncatedContext: false,
      };
    });
    const { controller, events } = controllerOf(readAgent, interactiveAgent);

    controller.startAsk(TAB, 'Click save', 'interact');
    await interactInGenerate.promise;
    controller.startAsk(TAB, 'Read question?', 'read');
    releaseInteract.resolve();
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));

    assert.deepEqual(interactiveAgent.cancelCalls, [TAB]);
    assert.equal(readAgent.answerCalls.length, 1);
    const finished = events.find((event) => event.type === 'answer-finished');
    assert.equal(finished?.type === 'answer-finished' && finished.answer.text, 'from-read');
    assert.equal(
      events.some((event) => event.type === 'answer-text' && event.delta === 'late-interact'),
      false,
    );
  });

  it('cancels only the current read askId through readAgent', async () => {
    const hold = new Deferred<AgentAnswer>();
    const readAgent = new FakeReadAgent(async () => hold.promise);
    const { controller } = controllerOf(readAgent, new FakeInteractionAgent());
    const askA = controller.startAsk(TAB, 'A?', 'read');
    const askB = controller.startAsk(TAB, 'B?', 'read');
    assert.equal(askA.ok && askB.ok, true);
    if (!askA.ok || !askB.ok) {
      return;
    }
    assert.deepEqual(controller.cancelAsk(TAB, askA.askId), { cancelled: false });
    assert.deepEqual(controller.cancelAsk(TAB, askB.askId), { cancelled: true });
    assert.deepEqual(readAgent.cancelCalls, [TAB, TAB]);
    hold.reject(new ModelError('REQUEST_CANCELLED', 'cancelled'));
    await hold.promise.catch(() => undefined);
  });

  it('cancels only the current interact askId through interactiveAgent', async () => {
    const hold = new Deferred<InteractiveAgentResult>();
    const interactiveAgent = new FakeInteractionAgent(async () => hold.promise);
    const { controller } = controllerOf(new FakeReadAgent(), interactiveAgent);
    const askA = controller.startAsk(TAB, 'A?', 'interact');
    const askB = controller.startAsk(TAB, 'B?', 'interact');
    assert.equal(askA.ok && askB.ok, true);
    if (!askA.ok || !askB.ok) {
      return;
    }
    assert.deepEqual(controller.cancelAsk(TAB, askA.askId), { cancelled: false });
    assert.deepEqual(controller.cancelAsk(TAB, askB.askId), { cancelled: true });
    assert.deepEqual(interactiveAgent.cancelCalls, [TAB, TAB]);
    hold.reject(new ModelError('REQUEST_CANCELLED', 'cancelled'));
    await hold.promise.catch(() => undefined);
  });

  it('clears both conversation stores and cancels the active owner', async () => {
    const hold = new Deferred<AgentAnswer>();
    const readAgent = new FakeReadAgent(async () => hold.promise);
    const interactiveAgent = new FakeInteractionAgent();
    const { controller, events } = controllerOf(readAgent, interactiveAgent);
    controller.startAsk(TAB, 'Remember this?', 'read');
    await waitUntil(() => events.some((event) => event.type === 'answer-started'));
    const cleared = controller.clearConversation(TAB);
    assert.deepEqual(cleared, { ok: true });
    assert.deepEqual(readAgent.cancelCalls, [TAB]);
    assert.deepEqual(readAgent.clearCalls, [TAB]);
    assert.deepEqual(interactiveAgent.clearCalls, [TAB]);
    hold.resolve(agentAnswer());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.some((event) => event.type === 'answer-finished'), false);
  });

  it('dispose cancels active requests and clears both conversation stores', () => {
    const readAgent = new FakeReadAgent();
    const interactiveAgent = new FakeInteractionAgent();
    const { controller } = controllerOf(readAgent, interactiveAgent);
    controller.startAsk(TAB, 'Question?', 'read');
    controller.dispose();
    assert.equal(readAgent.cancelCalls.length, 1);
    assert.equal(interactiveAgent.cancelCalls.length, 1);
    assert.equal(readAgent.clearAllCount, 1);
    assert.equal(interactiveAgent.clearAllCount, 1);
  });

  it('never leaks typed interaction secrets in serialized events', async () => {
    const interactiveAgent = new FakeInteractionAgent(async () => ({
      kind: 'interaction',
      alias: 'page-standard',
      truncatedContext: false,
      result: interactionResult({
        status: 'denied',
        errorCode: 'INTERACTION_DENIED',
      }),
    }));
    const { controller, events } = controllerOf(new FakeReadAgent(), interactiveAgent);
    controller.startAsk(TAB, TYPED_SECRET, 'interact');
    await waitUntil(() => events.some((event) => event.type === 'interaction-denied'));
    assert.equal(JSON.stringify(events).includes(TYPED_SECRET), false);
  });

  it('maps REQUEST_CANCELLED to answer-cancelled for interact mode', async () => {
    const interactiveAgent = new FakeInteractionAgent(async () => {
      throw new ModelError('REQUEST_CANCELLED', 'cancelled internally');
    });
    const { controller, events } = controllerOf(new FakeReadAgent(), interactiveAgent);
    controller.startAsk(TAB, 'Click save', 'interact');
    await waitUntil(() => events.some((event) => event.type === 'answer-cancelled'));
    assert.equal(events[0]?.type, 'interaction-started');
    assert.equal(events.at(-1)?.type, 'answer-cancelled');
    assert.equal(events.some((event) => event.type === 'interaction-failed'), false);
  });

  it('sanitizes ModelError events and never leaks a secret cause', async () => {
    const readAgent = new FakeReadAgent(async () => {
      throw new ModelError('MODEL_RATE_LIMITED', `rate ${SECRET}`, { cause: SECRET });
    });
    const { controller, events } = controllerOf(readAgent, new FakeInteractionAgent());
    controller.startAsk(TAB, 'What is this?', 'read');
    await waitUntil(() => events.some((event) => event.type === 'answer-error'));
    assert.equal(JSON.stringify(events).includes(SECRET), false);
  });

  it('suppresses late events from a superseded same-mode ask', async () => {
    const first = new Deferred<AgentAnswer>();
    const second = new Deferred<AgentAnswer>();
    let calls = 0;
    const readAgent = new FakeReadAgent(async (_request, options) => {
      calls += 1;
      if (calls === 1) {
        const result = await first.promise;
        options?.onTextDelta?.('late-A');
        return result;
      }
      return second.promise;
    });
    const { controller, events } = controllerOf(readAgent, new FakeInteractionAgent());

    const askA = controller.startAsk(TAB, 'Question A?', 'read');
    await waitUntil(() => events.some((event) => event.type === 'answer-started'));
    const askB = controller.startAsk(TAB, 'Question B?', 'read');
    await waitUntil(
      () => events.filter((event) => event.type === 'answer-started').length === 2,
    );

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
  });

  it('emits interaction-approval-required without denial or authority tokens', async () => {
    const interactiveAgent = new FakeInteractionAgent(async () => ({
      kind: 'interaction',
      alias: 'page-standard',
      truncatedContext: true,
      result: { status: 'approval-required' },
    }));
    const { controller, events } = controllerOf(new FakeReadAgent(), interactiveAgent);
    controller.startAsk(TAB, 'Buy now', 'interact');
    await waitUntil(() => events.some((event) => event.type === 'interaction-approval-required'));

    const required = events.find((event) => event.type === 'interaction-approval-required');
    assert.equal(required?.type, 'interaction-approval-required');
    if (required?.type === 'interaction-approval-required') {
      assert.equal(required.tabId, TAB);
      assert.equal(required.truncatedContext, true);
    }
    assert.equal(events.some((event) => event.type === 'interaction-denied'), false);
    const serialized = JSON.stringify(events);
    for (const token of ['approvalId', 'targetId', 'executionId', 'preparedActionId', 'ExecuteGrant']) {
      assert.equal(serialized.includes(token), false, token);
    }
  });

  it('invalidates same-tab approvals before starting a new ask', () => {
    const invalidated: string[] = [];
    const hold = new Deferred<InteractiveAgentResult>();
    const interactiveAgent = new FakeInteractionAgent(async () => hold.promise);
    const events: AiAnswerEvent[] = [];
    const controller = new AiRequestController({
      readAgent: new FakeReadAgent(),
      interactiveAgent,
      emit: (event) => {
        events.push(event);
      },
      invalidateApprovalsForTab: (tabId) => {
        invalidated.push(tabId);
      },
    });

    controller.startAsk(TAB, 'Buy now', 'interact');
    assert.deepEqual(invalidated, [TAB]);
    controller.startAsk('tab-2', 'Read this', 'read');
    assert.deepEqual(invalidated, [TAB, 'tab-2']);
    controller.startAsk(TAB, 'Another action', 'interact');
    assert.deepEqual(invalidated, [TAB, 'tab-2', TAB]);
    hold.resolve({
      kind: 'answer',
      text: 'later',
      referencedTargets: [],
      alias: 'page-standard',
      truncatedContext: false,
    });
  });

  it('invalidates approvals when clearing a conversation', () => {
    const invalidated: string[] = [];
    const controller = new AiRequestController({
      readAgent: new FakeReadAgent(),
      interactiveAgent: new FakeInteractionAgent(),
      emit: () => undefined,
      invalidateApprovalsForTab: (tabId) => {
        invalidated.push(tabId);
      },
    });
    controller.clearConversation(TAB);
    assert.deepEqual(invalidated, [TAB]);
  });

  it('delegates production Act to AgentRunController instead of InteractiveAgent', async () => {
    const interactiveAgent = new FakeInteractionAgent();
    const starts: string[] = [];
    const cancelActiveCalls: string[] = [];
    const events: AiAnswerEvent[] = [];
    const controller = new AiRequestController({
      readAgent: new FakeReadAgent(),
      interactiveAgent,
      agentRuns: {
        start: async (_tabId, instruction, options) => {
          starts.push(instruction);
          return {
            status: 'started',
            run: {
              runId: 'run-1',
              tabId: TAB,
              generation: 1,
              instruction,
              startedAt: 1,
              state: 'running',
              modelStepCount: 0,
              actionAttemptCount: 0,
              approvalCount: 0,
            },
            completion: Promise.resolve({
              status: 'completed',
              run: {
                runId: 'run-1',
                tabId: TAB,
                generation: 1,
                instruction,
                startedAt: 1,
                state: 'completed',
                modelStepCount: 1,
                actionAttemptCount: 0,
                approvalCount: 0,
                terminalReason: 'COMPLETED',
              },
              answer: {
                text: 'done',
                referencedTargets: [],
                alias: 'page-standard',
                truncatedContext: false,
                documentRevision: 'rev-1',
              },
            }),
          };
        },
        cancel: () => true,
        cancelActive: async (tabId) => {
          cancelActiveCalls.push(tabId);
        },
        clearConversation: () => undefined,
        handleTabClosed: () => undefined,
        handleRendererCrash: () => undefined,
        dispose: () => undefined,
      },
      emit: (event) => {
        events.push(event);
      },
    });

    controller.startAsk(TAB, 'Click save', 'interact');
    await waitUntil(() => starts.length === 1);
    assert.equal(interactiveAgent.interactCalls.length, 0);
    assert.deepEqual(starts, ['Click save']);

    controller.startAsk(TAB, 'What is this?', 'read');
    await waitUntil(() => cancelActiveCalls.length === 1);
    assert.deepEqual(cancelActiveCalls, [TAB]);
  });
});
