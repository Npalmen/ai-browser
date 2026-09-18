import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { InteractiveStepAgent } from '../ai/interactive-step-agent';
import type { InteractionModelRuntime } from '../ai/interaction-model-runtime';
import type { AgentModelOutput } from '../ai/interaction-output-schema';
import { MODEL_CATALOG } from '../ai/model-catalog';
import { ModelError } from '../ai/model-errors';
import type { ModelRequest } from '../ai/model-types';
import { TRUSTED_RUN_PROGRESS_OPEN } from '../ai/trusted-run-progress';
import type { PageState, TabId } from '../shared/browser-types';
import type {
  BoundInteractionProposal,
  InteractionResult,
} from '../shared/interaction-types';
import type {
  ObservationNode,
  ObservePageOptions,
  PageObservation,
} from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';
import { AgentRunCoordinator } from './agent-run-coordinator';
import {
  MAX_AGENT_LOOP_ACTION_ATTEMPTS,
  MAX_AGENT_LOOP_MODEL_STEPS,
  toAgentRunRef,
  type AgentRunRef,
  type AgentRunSnapshot,
} from './agent-run-types';
import { SafeAgentLoop, type SafeV3InteractionExecutionPort } from './safe-agent-loop';
import type {
  InteractiveStepOptions,
  InteractiveStepRequest,
  InteractiveStepResult,
} from '../ai/interactive-step-agent';

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

function pageState(tabId: TabId = TAB): PageState {
  return {
    tabId,
    url: 'https://example.com/page',
    title: 'Example page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
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
    ...overrides,
  };
}

function boundClick(
  revision = 'rev-a',
  targetId = 'target-1',
  observationId = 'obs-1',
): BoundInteractionProposal {
  return {
    kind: 'click',
    targetId,
    tabId: TAB,
    observationId,
    documentRevision: revision,
  };
}

function succeeded(
  postObservation: PageObservation,
  actionId = 'action-1',
): InteractionResult {
  return {
    actionId,
    status: 'succeeded',
    pageState: pageState(),
    observation: postObservation,
  };
}

function denied(errorCode: InteractionResult['errorCode']): InteractionResult {
  return {
    actionId: 'action-1',
    status: 'denied',
    pageState: pageState(),
    errorCode,
  };
}

function failed(errorCode: InteractionResult['errorCode']): InteractionResult {
  return {
    actionId: 'action-1',
    status: 'failed',
    pageState: pageState(),
    errorCode,
  };
}

class FakeStepAgent {
  readonly calls: Array<{
    request: InteractiveStepRequest;
    options?: InteractiveStepOptions;
  }> = [];
  private index = 0;
  private readonly responses: InteractiveStepResult[];
  private readonly impl?: (
    request: InteractiveStepRequest,
    options: InteractiveStepOptions | undefined,
    callIndex: number,
  ) => Promise<InteractiveStepResult>;

  constructor(
    responses: InteractiveStepResult[] | FakeStepAgent['impl'],
  ) {
    if (typeof responses === 'function') {
      this.responses = [];
      this.impl = responses;
    } else {
      this.responses = responses as InteractiveStepResult[];
    }
  }

  async step(
    request: InteractiveStepRequest,
    options?: InteractiveStepOptions,
  ): Promise<InteractiveStepResult> {
    this.calls.push({
      request,
      options: options
        ? {
            ...options,
            trustedProgress: options.trustedProgress
              ? [...options.trustedProgress]
              : undefined,
          }
        : undefined,
    });
    if (this.impl) {
      return this.impl(request, options, this.calls.length);
    }
    const next = this.responses[this.index];
    this.index += 1;
    if (!next) {
      throw new Error('No scripted step response');
    }
    if (options?.priorConversationForRevision !== undefined) {
      options.priorConversationForRevision(
        request.tabId,
        next.observation.document.revision,
      );
    }
    return next;
  }
}

class FakeV3Executor implements SafeV3InteractionExecutionPort {
  readonly calls: Array<{
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }> = [];
  private index = 0;
  private readonly results: InteractionResult[];
  private readonly impl?: (
    input: FakeV3Executor['calls'][number],
    callIndex: number,
  ) => Promise<InteractionResult>;

  constructor(results: InteractionResult[] | FakeV3Executor['impl']) {
    if (typeof results === 'function') {
      this.results = [];
      this.impl = results;
    } else {
      this.results = results as InteractionResult[];
    }
  }

  async execute(input: {
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): Promise<InteractionResult> {
    this.calls.push(input);
    if (this.impl) {
      return this.impl(input, this.calls.length);
    }
    const next = this.results[this.index];
    this.index += 1;
    if (!next) {
      throw new Error('No scripted executor result');
    }
    return next;
  }
}

function createLoop(input: {
  coordinator?: AgentRunCoordinator;
  stepAgent: FakeStepAgent;
  executor: FakeV3Executor;
}) {
  const coordinator = input.coordinator ?? new AgentRunCoordinator();
  const loop = new SafeAgentLoop({
    coordinator,
    stepAgent: input.stepAgent,
    interactionExecutor: input.executor,
  });
  return { coordinator, loop };
}

function start(coordinator: AgentRunCoordinator, instruction = 'do the task'): AgentRunSnapshot {
  return coordinator.startRun(TAB, instruction);
}

function refOf(snapshot: AgentRunSnapshot): AgentRunRef {
  return toAgentRunRef(snapshot);
}

function proposalStep(
  proposal: BoundInteractionProposal,
  obs: PageObservation,
): InteractiveStepResult {
  return {
    kind: 'proposal',
    proposal,
    observation: obs,
    alias: 'page-standard',
    truncatedContext: false,
  };
}

function answerStep(text: string, obs: PageObservation): InteractiveStepResult {
  return {
    kind: 'answer',
    text,
    referencedTargets: [],
    alias: 'page-standard',
    truncatedContext: false,
    observation: obs,
  };
}

describe('SafeAgentLoop integration', () => {
  it('completes two safe actions then a final answer', async () => {
    const obs1 = observation({ observationId: 'obs-1', document: { ...observation().document, revision: 'rev-1' } });
    const obs2 = observation({ observationId: 'obs-2', document: { ...observation().document, revision: 'rev-2' } });
    const obs3 = observation({ observationId: 'obs-3', document: { ...observation().document, revision: 'rev-3' } });
    const stepAgent = new FakeStepAgent([
      proposalStep(boundClick('rev-1'), obs1),
      proposalStep(boundClick('rev-2', 'target-2'), obs2),
      answerStep('Done', obs3),
    ]);
    const executor = new FakeV3Executor([
      succeeded(observation({ observationId: 'obs-post-1', document: { ...obs1.document, revision: 'rev-1b' } })),
      succeeded(observation({ observationId: 'obs-post-2', document: { ...obs2.document, revision: 'rev-2b' } })),
    ]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    const run = start(coordinator);

    const result = await loop.run(refOf(run));

    assert.equal(result.status, 'completed');
    if (result.status === 'completed') {
      assert.equal(result.answer.text, 'Done');
      assert.equal(result.run.modelStepCount, 3);
      assert.equal(result.run.actionAttemptCount, 2);
      assert.equal(result.run.approvalCount, 0);
    }
    assert.equal(executor.calls.length, 2);
    assert.equal(stepAgent.calls.length, 3);
    assert.equal(stepAgent.calls[1]?.options?.trustedProgress?.length, 1);
    assert.equal(stepAgent.calls[2]?.options?.trustedProgress?.length, 2);
    assert.equal(stepAgent.calls[1]?.options?.priorConversationForRevision, undefined);
  });

  it('continues after navigation-producing safe click', async () => {
    const obs1 = observation({ document: { ...observation().document, revision: 'rev-1' } });
    const obs2 = observation({ document: { ...observation().document, revision: 'rev-2' } });
    const stepAgent = new FakeStepAgent([
      proposalStep(boundClick('rev-1'), obs1),
      proposalStep(boundClick('rev-2'), obs2),
      answerStep('Done', obs2),
    ]);
    const executor = new FakeV3Executor([
      succeeded(observation({ document: { ...obs1.document, revision: 'rev-nav' } })),
      succeeded(observation({ document: { ...obs2.document, revision: 'rev-2b' } })),
    ]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    const run = start(coordinator);

    const result = await loop.run(refOf(run));
    assert.equal(result.status, 'completed');
    assert.equal(stepAgent.calls[1]?.options?.trustedProgress?.[0]?.kind, 'safe-interaction-succeeded');
    if (stepAgent.calls[1]?.options?.trustedProgress?.[0]?.kind === 'safe-interaction-succeeded') {
      assert.equal(stepAgent.calls[1].options.trustedProgress[0].pageChanged, true);
    }
  });

  it('passes prior conversation only on the first model step', async () => {
    const priorCalls: string[] = [];
    const stepAgent = new FakeStepAgent([
      proposalStep(boundClick(), observation()),
      answerStep('Done', observation()),
    ]);
    const executor = new FakeV3Executor([
      succeeded(observation()),
    ]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    const run = start(coordinator);

    await loop.run(refOf(run), {
      priorConversationForRevision: (_tabId, revision) => {
        priorCalls.push(revision);
        return '<PRIOR_CONVERSATION>earlier</PRIOR_CONVERSATION>';
      },
    });

    assert.deepEqual(priorCalls, ['rev-a']);
    assert.equal(typeof stepAgent.calls[0]?.options?.priorConversationForRevision, 'function');
    assert.equal(stepAgent.calls[1]?.options?.priorConversationForRevision, undefined);
  });
});

describe('SafeAgentLoop termination', () => {
  it('blocks on V3 DENY without another model step', async () => {
    const { coordinator, loop } = createLoop({
      stepAgent: new FakeStepAgent([proposalStep(boundClick(), observation())]),
      executor: new FakeV3Executor([denied('INTERACTION_DENIED')]),
    });
    const run = start(coordinator);
    const result = await loop.run(refOf(run));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.state, 'blocked');
      assert.equal(result.run.terminalReason, 'POLICY_BLOCKED');
      assert.equal(result.run.actionAttemptCount, 1);
    }
  });

  it('blocks sensitive typing without approval', async () => {
    const { coordinator, loop } = createLoop({
      stepAgent: new FakeStepAgent([proposalStep(boundClick(), observation())]),
      executor: new FakeV3Executor([denied('TARGET_SENSITIVE')]),
    });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'POLICY_BLOCKED');
      assert.equal(result.run.approvalCount, 0);
    }
  });

  it('blocks DEFER_EXECUTE without preparing approval', async () => {
    const { coordinator, loop } = createLoop({
      stepAgent: new FakeStepAgent([proposalStep(boundClick(), observation())]),
      executor: new FakeV3Executor([denied('DEFERRED_TO_EXECUTE')]),
    });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'UNSUPPORTED_ACTION');
      assert.equal(result.run.approvalCount, 0);
    }
  });

  it('fails on mechanical V3 failure', async () => {
    const { coordinator, loop } = createLoop({
      stepAgent: new FakeStepAgent([proposalStep(boundClick(), observation())]),
      executor: new FakeV3Executor([failed('INTERACTION_FAILED')]),
    });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.state, 'failed');
      assert.equal(result.run.terminalReason, 'ACTION_FAILED');
    }
  });

  it('blocks on stale V3 failure', async () => {
    const { coordinator, loop } = createLoop({
      stepAgent: new FakeStepAgent([proposalStep(boundClick(), observation())]),
      executor: new FakeV3Executor([failed('TARGET_STALE')]),
    });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.state, 'blocked');
      assert.equal(result.run.terminalReason, 'ACTION_STALE');
    }
  });

  it('fails when succeeded result lacks post-action observation', async () => {
    const { coordinator, loop } = createLoop({
      stepAgent: new FakeStepAgent([proposalStep(boundClick(), observation())]),
      executor: new FakeV3Executor([
        { actionId: 'action-1', status: 'succeeded', pageState: pageState() },
      ]),
    });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.state, 'failed');
      assert.equal(result.run.terminalReason, 'ACTION_FAILED');
    }
  });

  it('fails when post-action observation is for another tab', async () => {
    const { coordinator, loop } = createLoop({
      stepAgent: new FakeStepAgent([proposalStep(boundClick(), observation())]),
      executor: new FakeV3Executor([
        succeeded(observation({ tabId: 'tab-other' })),
      ]),
    });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.state, 'failed');
    }
  });

  it('fails on invalid model output without incrementing model steps', async () => {
    const stepAgent = new FakeStepAgent(async () => {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'invalid');
    });
    const executor = new FakeV3Executor([]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.state, 'failed');
      assert.equal(result.run.terminalReason, 'MODEL_FAILED');
      assert.equal(result.run.modelStepCount, 0);
      assert.equal(result.run.actionAttemptCount, 0);
    }
    assert.equal(executor.calls.length, 0);
  });
});

describe('SafeAgentLoop budgets and no-progress', () => {
  it('blocks repeated identical proposal without a second executor call', async () => {
    const obs = observation({ document: { ...observation().document, revision: 'rev-1' } });
    const stepAgent = new FakeStepAgent([
      proposalStep(boundClick('rev-1'), obs),
      proposalStep(boundClick('rev-1'), obs),
      answerStep('late', obs),
    ]);
    const executor = new FakeV3Executor([
      succeeded(observation({ document: { ...obs.document, revision: 'rev-1' } })),
    ]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'AGENT_LOOP_NO_PROGRESS');
      assert.equal(result.run.actionAttemptCount, 1);
    }
    assert.equal(executor.calls.length, 1);
  });

  it('allows the same target on a new document revision', async () => {
    const obs1 = observation({ document: { ...observation().document, revision: 'rev-1' } });
    const obs2 = observation({ document: { ...observation().document, revision: 'rev-2' } });
    const stepAgent = new FakeStepAgent([
      proposalStep(boundClick('rev-1'), obs1),
      proposalStep(boundClick('rev-2'), obs2),
      answerStep('Done', obs2),
    ]);
    const executor = new FakeV3Executor([
      succeeded(observation({ document: { ...obs1.document, revision: 'rev-1b' } })),
      succeeded(observation({ document: { ...obs2.document, revision: 'rev-2b' } })),
    ]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'completed');
    assert.equal(executor.calls.length, 2);
  });

  it('blocks the seventh action attempt after six successes', async () => {
    const responses: InteractiveStepResult[] = [];
    const results: InteractionResult[] = [];
    for (let index = 0; index < 6; index += 1) {
      const revision = `rev-${index}`;
      const obs = observation({ document: { ...observation().document, revision } });
      responses.push(proposalStep(boundClick(revision), obs));
      results.push(succeeded(observation({ document: { ...obs.document, revision: `${revision}b` } })));
    }
    responses.push(proposalStep(boundClick('rev-6'), observation({ document: { ...observation().document, revision: 'rev-6' } })));
    const stepAgent = new FakeStepAgent(responses);
    const executor = new FakeV3Executor(results);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'STEP_LIMIT_REACHED');
      assert.equal(result.run.actionAttemptCount, MAX_AGENT_LOOP_ACTION_ATTEMPTS);
    }
    assert.equal(executor.calls.length, 6);
  });

  it('does not call the step agent when model budget is already exhausted', async () => {
    const coordinator = new AgentRunCoordinator();
    const run = start(coordinator);
    const ref = refOf(run);
    for (let index = 0; index < MAX_AGENT_LOOP_MODEL_STEPS; index += 1) {
      coordinator.recordModelStepCompleted(ref);
    }
    const stepAgent = new FakeStepAgent([answerStep('late', observation())]);
    const executor = new FakeV3Executor([]);
    const loop = new SafeAgentLoop({ coordinator, stepAgent, interactionExecutor: executor });
    const result = await loop.run(ref);
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'STEP_LIMIT_REACHED');
      assert.equal(result.run.modelStepCount, MAX_AGENT_LOOP_MODEL_STEPS);
    }
    assert.equal(stepAgent.calls.length, 0);
    assert.equal(executor.calls.length, 0);
  });
});

describe('SafeAgentLoop races and cancellation', () => {
  it('ignores late model results after supersede', async () => {
    const modelGate = new Deferred<void>();
    const stepAgent = new FakeStepAgent(async () => {
      await modelGate.promise;
      return answerStep('late', observation());
    });
    const executor = new FakeV3Executor([]);
    const coordinator = new AgentRunCoordinator();
    const loop = new SafeAgentLoop({ coordinator, stepAgent, interactionExecutor: executor });
    const runA = start(coordinator, 'task A');
    const pendingA = loop.run(refOf(runA));
    const runB = start(coordinator, 'task B');
    modelGate.resolve();
    const resultA = await pendingA;
    assert.equal(resultA.status, 'ignored');
    assert.equal(executor.calls.length, 0);
    assert.equal(coordinator.getRun(runA.runId)?.terminalReason, 'SUPERSEDED');
    assert.equal(coordinator.getActiveRunForTab(TAB)?.runId, runB.runId);
  });

  it('ignores late executor results after supersede without recording progress', async () => {
    const execGate = new Deferred<void>();
    const obs = observation();
    const stepAgent = new FakeStepAgent([
      proposalStep(boundClick(), obs),
      answerStep('never', obs),
    ]);
    const executor = new FakeV3Executor(async () => {
      await execGate.promise;
      return succeeded(observation({ document: { ...obs.document, revision: 'rev-late' } }));
    });
    const coordinator = new AgentRunCoordinator();
    const loop = new SafeAgentLoop({ coordinator, stepAgent, interactionExecutor: executor });
    const runA = start(coordinator, 'task A');
    const pendingA = loop.run(refOf(runA));
    start(coordinator, 'task B');
    execGate.resolve();
    const resultA = await pendingA;
    assert.equal(resultA.status, 'ignored');
    assert.equal(stepAgent.calls.length, 1);
    assert.equal(coordinator.getRun(runA.runId)?.terminalReason, 'SUPERSEDED');
  });

  it('cancels during model generation for the current run', async () => {
    const modelGate = new Deferred<void>();
    const controller = new AbortController();
    const stepAgent = new FakeStepAgent(async (_request, options) => {
      await modelGate.promise;
      if (options?.signal?.aborted) {
        throw new ModelError('REQUEST_CANCELLED', 'cancelled');
      }
      return answerStep('late', observation());
    });
    const { coordinator, loop } = createLoop({
      stepAgent,
      executor: new FakeV3Executor([]),
    });
    const pending = loop.run(refOf(start(coordinator)), { signal: controller.signal });
    controller.abort();
    modelGate.resolve();
    const result = await pending;
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.state, 'cancelled');
      assert.equal(result.run.terminalReason, 'USER_CANCELLED');
    }
  });

  it('cancels after one successful action before the next model step', async () => {
    const secondStepGate = new Deferred<void>();
    const controller = new AbortController();
    const obs = observation();
    const stepAgent = new FakeStepAgent(async (_request, options, callIndex) => {
      if (callIndex === 1) {
        return proposalStep(boundClick(), obs);
      }
      await secondStepGate.promise;
      if (options?.signal?.aborted) {
        throw new ModelError('REQUEST_CANCELLED', 'cancelled');
      }
      return answerStep('never', obs);
    });
    const executor = new FakeV3Executor([succeeded(observation())]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    const pending = loop.run(refOf(start(coordinator)), { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    secondStepGate.resolve();
    const result = await pending;
    assert.equal(result.status, 'terminal');
    if (result.status === 'terminal') {
      assert.equal(result.run.terminalReason, 'USER_CANCELLED');
    }
    assert.equal(stepAgent.calls.length, 2);
    assert.equal(executor.calls.length, 1);
  });
});

describe('SafeAgentLoop fresh observation policy', () => {
  it('does not pass trustedObservation to the step agent after V3 success', async () => {
    const obs1 = observation({ observationId: 'obs-1' });
    const obs2 = observation({ observationId: 'obs-2' });
    const stepAgent = new FakeStepAgent([
      proposalStep(boundClick(), obs1),
      answerStep('Done', obs2),
    ]);
    const executor = new FakeV3Executor([
      succeeded(observation({ observationId: 'obs-post-1' })),
    ]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    await loop.run(refOf(start(coordinator)));
    assert.equal(stepAgent.calls[0]?.options?.trustedObservation, undefined);
    assert.equal(stepAgent.calls[1]?.options?.trustedObservation, undefined);
  });
});

describe('SafeAgentLoop provider fallback logical count', () => {
  it('counts provider fallback inside InteractiveStepAgent as one model step', async () => {
    class FakeObservationSource {
      readonly calls: Array<{ tabId: TabId; options?: ObservePageOptions }> = [];
      async observePage(tabId: TabId, options?: ObservePageOptions): Promise<PageObservation> {
        this.calls.push({ tabId, options });
        return observation();
      }
    }

    let callIndex = 0;
    const wrappedRuntime: InteractionModelRuntime = {
      async generateInteraction(request, options) {
        callIndex += 1;
        if (callIndex === 1) {
          throw new ModelError('MODEL_UNAVAILABLE', 'unavailable');
        }
        return {
          output: { kind: 'answer', text: 'Fallback answer', referencedTargets: [] },
          resolvedProviderModelId: 'test/fallback',
          latencyMs: 1,
        };
      },
    };

    const stepAgent = new InteractiveStepAgent({
      observationSource: new FakeObservationSource(),
      modelRuntime: wrappedRuntime,
      allowScreenshotExport: false,
      catalog: MODEL_CATALOG,
    });
    const coordinator = new AgentRunCoordinator();
    const loop = new SafeAgentLoop({
      coordinator,
      stepAgent,
      interactionExecutor: new FakeV3Executor([]),
    });
    const result = await loop.run(refOf(start(coordinator)));
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') {
      assert.equal(result.run.modelStepCount, 1);
    }
  });
});

describe('SafeAgentLoop trusted progress privacy', () => {
  it('does not leak canary values inside TRUSTED_RUN_PROGRESS', async () => {
    const obs1 = observation();
    const obs2 = observation({ document: { ...observation().document, revision: 'rev-2' } });
    const stepAgent = new FakeStepAgent([
      proposalStep(
        {
          kind: 'type',
          targetId: 'target-1',
          text: 'typed-secret-CANARY',
          tabId: TAB,
          observationId: 'obs-1',
          documentRevision: 'rev-a',
        },
        obs1,
      ),
      answerStep('Done', obs2),
    ]);
    const executor = new FakeV3Executor([succeeded(observation())]);
    const { coordinator, loop } = createLoop({ stepAgent, executor });
    await loop.run(refOf(start(coordinator)));
    const progressText = JSON.stringify(stepAgent.calls[1]?.options?.trustedProgress ?? []);
    assert.match(progressText, /safe-interaction-succeeded/);
    for (const needle of [
      'targetId-CANARY',
      'approvalId-CANARY',
      'executionId-CANARY',
      'runId-CANARY',
      'backendNodeId-CANARY',
      'frameId-CANARY',
      'typed-secret-CANARY',
      'documentRevision',
    ]) {
      assert.equal(progressText.includes(needle), false, needle);
    }
  });
});

describe('SafeAgentLoop source isolation', () => {
  it('does not import ConversationStore, V4 workflow, or browser surfaces', () => {
    const source = readFileSync(path.join(__dirname, 'safe-agent-loop.ts'), 'utf8');
    const forbidden = [
      'ConversationStore',
      'commitTurn',
      'InteractiveAgent',
      'InteractionCoordinator',
      'PrepareActionService',
      'ApprovalManager',
      'ApprovalLifecycle',
      'ApprovalController',
      'ApprovalWorkflowController',
      'ExecuteExecutor',
      'ExecuteGrant',
      'BrowserAdapter',
      'ipcMain',
      "from 'electron'",
      "from 'react'",
    ];
    for (const needle of forbidden) {
      assert.equal(source.includes(needle), false, needle);
    }
  });
});
