import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import {
  APICallError,
  NoObjectGeneratedError,
  NoSuchModelError,
} from 'ai';

import { getModelProfile } from '../model-catalog';
import { ModelError } from '../model-errors';
import { ModelRequestLog } from '../request-log';
import type { ModelRequest } from '../model-types';
import {
  AiSdkGatewayRuntime,
  mapRuntimeError,
  type GatewayStreamTextArgs,
  type GatewayStreamTextResult,
} from './ai-sdk-gateway';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: 'req-1',
    profile: getModelProfile('page-fast'),
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Summarize this page.' }],
      },
    ],
    ...overrides,
  };
}

function settled<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function streamResult(
  overrides: Partial<GatewayStreamTextResult> = {},
): GatewayStreamTextResult {
  return {
    partialOutputStream: (async function* () {})(),
    output: settled({
      text: 'Example answer',
      referencedTargets: ['target-1'],
    }),
    usage: settled({
      inputTokens: 10,
      outputTokens: 4,
    }),
    providerMetadata: settled({ gateway: { cost: 0.002 } }),
    response: settled({ modelId: 'openai/gpt-5-nano' }),
    ...overrides,
  };
}

describe('AiSdkGatewayRuntime', () => {
  it('returns a normalized ModelResponse from a validated final object', async () => {
    const log = new ModelRequestLog();
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: log,
      streamText: () => streamResult(),
    });

    const response = await runtime.generate(request());

    assert.equal(response.text, 'Example answer');
    assert.deepEqual(response.referencedTargets, ['target-1']);
    assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 4 });
    assert.deepEqual(response.cost, {
      knowledge: 'known',
      amountUsd: 0.002,
      currency: 'USD',
    });
    assert.equal(response.resolvedProviderModelId, 'openai/gpt-5-nano');
    assert.ok(response.latencyMs >= 0);
    assert.equal(log.list()[0]?.success, true);
  });

  it('emits append-safe text deltas from cumulative partial output', async () => {
    const deltas: string[] = [];
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        streamResult({
          partialOutputStream: (async function* () {
            yield { text: 'H', referencedTargets: [] };
            yield { text: 'Hel', reasoning: 'hidden' };
            yield { text: 'Hello' };
          })(),
        }),
    });

    const response = await runtime.generate(request(), {
      onTextDelta: (text) => deltas.push(text),
    });

    assert.deepEqual(deltas, ['H', 'el', 'lo']);
    assert.equal(response.text, 'Example answer');
  });

  it('does not stream reasoning metadata through onTextDelta', async () => {
    const deltas: string[] = [];
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        streamResult({
          partialOutputStream: (async function* () {
            yield { reasoning: 'do not emit' };
            yield { text: 'Hi', reasoning: 'still hidden' };
          })(),
        }),
    });

    await runtime.generate(request(), {
      onTextDelta: (text) => deltas.push(text),
    });

    assert.deepEqual(deltas, ['Hi']);
  });

  it('fails MODEL_NOT_CONFIGURED without calling the SDK when the key is missing', async () => {
    let called = false;
    const previous = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;

    try {
      const runtime = new AiSdkGatewayRuntime({
        requestLog: new ModelRequestLog(),
        streamText: () => {
          called = true;
          return streamResult();
        },
      });

      await assert.rejects(
        () => runtime.generate(request()),
        (error: unknown) =>
          error instanceof ModelError && error.code === 'MODEL_NOT_CONFIGURED',
      );
      assert.equal(called, false);
    } finally {
      if (previous === undefined) {
        delete process.env.AI_GATEWAY_API_KEY;
      } else {
        process.env.AI_GATEWAY_API_KEY = previous;
      }
    }
  });

  it('fails REQUEST_CANCELLED without an SDK call when the caller signal is already aborted', async () => {
    let called = false;
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () => {
        called = true;
        return streamResult();
      },
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => runtime.generate(request(), { signal: controller.signal }),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'REQUEST_CANCELLED',
    );
    assert.equal(called, false);
  });

  it('maps abort during generation to REQUEST_CANCELLED without retrying', async () => {
    const controller = new AbortController();
    let calls = 0;
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: ({ abortSignal }) => {
        calls += 1;
        return streamResult({
          partialOutputStream: (async function* () {
            controller.abort();
            if (abortSignal?.aborted) {
              throw abortError();
            }
          })(),
        });
      },
    });

    await assert.rejects(
      () => runtime.generate(request(), { signal: controller.signal }),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'REQUEST_CANCELLED',
    );
    assert.equal(calls, 1);
  });

  it('maps a profile timeout to MODEL_TIMEOUT rather than cancellation', async () => {
    const timeout = new AbortController();
    timeout.abort();
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      createTimeoutSignal: () => timeout.signal,
      streamText: ({ abortSignal }) => {
        if (abortSignal?.aborted) {
          throw abortError();
        }
        return streamResult();
      },
    });

    await assert.rejects(
      () => runtime.generate(request()),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_TIMEOUT',
    );
  });

  it('applies catalog Gateway sort metadata without model fallbacks', async () => {
    const seen: GatewayStreamTextArgs[] = [];
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: (args) => {
        seen.push(args);
        return streamResult();
      },
    });

    await runtime.generate(request({ profile: getModelProfile('page-fast') }));
    await runtime.generate(request({ profile: getModelProfile('page-standard') }));
    await runtime.generate(request({ profile: getModelProfile('page-vision') }));
    await runtime.generate(request({ profile: getModelProfile('page-deep') }));

    assert.deepEqual(
      seen.map((args) => args.providerOptions),
      [
        { gateway: { sort: 'cost' } },
        { gateway: { sort: 'ttft' } },
        { gateway: { sort: 'ttft' } },
        undefined,
      ],
    );
    assert.equal(
      seen.every((args) => !('models' in (args.providerOptions?.gateway ?? {}))),
      true,
    );
  });

  it('converts user JPEG image parts to SDK file parts', async () => {
    let captured: GatewayStreamTextArgs | undefined;
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: (args) => {
        captured = args;
        return streamResult();
      },
    });

    await runtime.generate(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this screenshot?' },
              {
                type: 'image',
                mimeType: 'image/jpeg',
                dataBase64: 'abc123',
              },
            ],
          },
        ],
      }),
    );

    const user = captured?.messages[0];
    assert.equal(user?.role, 'user');
    assert.ok(Array.isArray(user?.content));
    const imagePart = user.content[1] as {
      type: string;
      mediaType: string;
      data: string;
    };
    assert.equal(imagePart.type, 'file');
    assert.equal(imagePart.mediaType, 'image/jpeg');
    assert.equal(imagePart.data, 'abc123');
  });

  it('rejects system image parts locally without an SDK call', async () => {
    let called = false;
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () => {
        called = true;
        return streamResult();
      },
    });

    await assert.rejects(
      () =>
        runtime.generate(
          request({
            messages: [
              {
                role: 'system',
                content: [
                  { type: 'text', text: 'Instructions' },
                  {
                    type: 'image',
                    mimeType: 'image/jpeg',
                    dataBase64: 'abc123',
                  },
                ],
              },
            ],
          }),
        ),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_REQUEST_FAILED',
    );
    assert.equal(called, false);
  });

  it('falls back to the profile model id when the response has no model id', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        streamResult({
          response: settled({}),
        }),
    });

    const response = await runtime.generate(
      request({ profile: getModelProfile('page-standard') }),
    );
    assert.equal(
      response.resolvedProviderModelId,
      getModelProfile('page-standard').providerModelId,
    );
  });

  it('returns unknown cost when Gateway cost metadata is missing', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        streamResult({
          providerMetadata: settled({}),
        }),
    });

    const response = await runtime.generate(request());
    assert.deepEqual(response.cost, { knowledge: 'unknown', currency: 'USD' });
  });

  it('uses the product output cap', async () => {
    let captured: GatewayStreamTextArgs | undefined;
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: (args) => {
        captured = args;
        return streamResult();
      },
    });

    await runtime.generate(request({ profile: getModelProfile('page-deep') }));
    assert.equal(captured?.maxOutputTokens, 4096);
  });
});

function interactionStreamResult(
  overrides: Partial<GatewayStreamTextResult> = {},
): GatewayStreamTextResult {
  return {
    partialOutputStream: (async function* () {})(),
    output: settled({
      kind: 'answer',
      text: 'Example answer',
      referencedTargets: ['target-1'],
    }),
    usage: settled({
      inputTokens: 10,
      outputTokens: 4,
    }),
    providerMetadata: settled({ gateway: { cost: 0.002 } }),
    response: settled({ modelId: 'openai/gpt-5-nano' }),
    ...overrides,
  };
}

describe('AiSdkGatewayRuntime.generateInteraction', () => {
  it('returns a validated answer output', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () => interactionStreamResult(),
    });

    const response = await runtime.generateInteraction(request());

    assert.equal(response.output.kind, 'answer');
    if (response.output.kind === 'answer') {
      assert.equal(response.output.text, 'Example answer');
      assert.deepEqual(response.output.referencedTargets, ['target-1']);
    }
  });

  it('returns a validated interaction click output', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        interactionStreamResult({
          output: settled({
            kind: 'interaction',
            proposal: { kind: 'click', targetId: 'target-1' },
          }),
        }),
    });

    const response = await runtime.generateInteraction(request());

    assert.equal(response.output.kind, 'interaction');
    if (response.output.kind === 'interaction') {
      assert.equal(response.output.proposal.kind, 'click');
      assert.equal(response.output.proposal.targetId, 'target-1');
    }
  });

  it('returns a validated interaction type output', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        interactionStreamResult({
          output: settled({
            kind: 'interaction',
            proposal: { kind: 'type', targetId: 'target-1', text: 'hello' },
          }),
        }),
    });

    const response = await runtime.generateInteraction(request());

    assert.equal(response.output.kind, 'interaction');
    if (response.output.kind === 'interaction') {
      assert.equal(response.output.proposal.kind, 'type');
      assert.equal(response.output.proposal.text, 'hello');
    }
  });

  it('rejects proposal authority fields as MODEL_OUTPUT_INVALID', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        interactionStreamResult({
          output: settled({
            kind: 'interaction',
            proposal: { kind: 'click', targetId: 'target-1', tabId: 'tab-1' },
          }),
        }),
    });

    await assert.rejects(
      () => runtime.generateInteraction(request()),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
  });

  it('logs trusted-main request-failed diagnostics without secrets', async () => {
    const logs: string[] = [];
    const restore = mock.method(console, 'log', (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      const runtime = new AiSdkGatewayRuntime({
        readGatewayApiKey: () => 'test-key',
        requestLog: new ModelRequestLog(),
        streamText: () =>
          interactionStreamResult({
            output: settled({
              kind: 'interaction',
              proposal: { kind: 'click', targetId: 'target-1', tabId: 'tab-1' },
            }),
          }),
      });

      await assert.rejects(() => runtime.generateInteraction(request()));
      const line = logs.find((entry) => entry.includes('[model] request-failed'));
      assert.ok(line);
      assert.match(line!, /alias=page-fast code=MODEL_OUTPUT_INVALID/);
      assert.match(line!, /category=output-invalid/);
      assert.match(line!, /phase=awaiting-structured/);
      assert.doesNotMatch(line!, /test-key/);
      assert.doesNotMatch(line!, /target-1/);
    } finally {
      restore.mock.restore();
    }
  });

  it('rejects unknown top-level fields as MODEL_OUTPUT_INVALID', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        interactionStreamResult({
          output: settled({
            kind: 'answer',
            text: 'x',
            referencedTargets: [],
            extra: true,
          }),
        }),
    });

    await assert.rejects(
      () => runtime.generateInteraction(request()),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
  });

  it('streams answer text deltas only for answer partials', async () => {
    const deltas: string[] = [];
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        interactionStreamResult({
          partialOutputStream: (async function* () {
            yield { kind: 'answer', text: 'A', referencedTargets: [] };
            yield { kind: 'answer', text: 'AB', referencedTargets: [] };
            yield { kind: 'answer', text: 'ABC', referencedTargets: [] };
          })(),
        }),
    });

    await runtime.generateInteraction(request(), {
      onAnswerTextDelta: (text) => deltas.push(text),
    });

    assert.deepEqual(deltas, ['A', 'B', 'C']);
  });

  it('does not stream interaction proposal contents through onAnswerTextDelta', async () => {
    const deltas: string[] = [];
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        interactionStreamResult({
          partialOutputStream: (async function* () {
            yield {
              kind: 'interaction',
              proposal: { kind: 'click', targetId: 'target-1' },
            };
            yield {
              kind: 'interaction',
              proposal: { kind: 'type', targetId: 'target-1', text: 'secret' },
            };
          })(),
          output: settled({
            kind: 'interaction',
            proposal: { kind: 'click', targetId: 'target-1' },
          }),
        }),
    });

    await runtime.generateInteraction(request(), {
      onAnswerTextDelta: (text) => deltas.push(text),
    });

    assert.deepEqual(deltas, []);
  });

  it('requests the agent model output schema', async () => {
    const seen: GatewayStreamTextArgs[] = [];
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: (args) => {
        seen.push(args);
        return interactionStreamResult();
      },
    });

    await runtime.generateInteraction(request());
    assert.equal(seen[0]?.outputSchema, 'agentModelOutput');
  });
});

function autonomousTaskDecisionStreamResult(
  overrides: Partial<GatewayStreamTextResult> = {},
): GatewayStreamTextResult {
  return {
    partialOutputStream: (async function* () {})(),
    output: settled({
      kind: 'delegate-subgoal',
      taskTabAlias: 'task-tab-1',
      instruction: 'Compare refundable prices',
    }),
    usage: settled({
      inputTokens: 10,
      outputTokens: 4,
    }),
    providerMetadata: settled({ gateway: { cost: 0.002 } }),
    response: settled({ modelId: 'openai/gpt-5-nano' }),
    ...overrides,
  };
}

describe('AiSdkGatewayRuntime.generateAutonomousTaskDecision', () => {
  it('returns a validated autonomous task decision', async () => {
    const log = new ModelRequestLog();
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: log,
      streamText: () => autonomousTaskDecisionStreamResult(),
    });

    const response = await runtime.generateAutonomousTaskDecision(request());

    assert.equal(response.decision.kind, 'delegate-subgoal');
    if (response.decision.kind === 'delegate-subgoal') {
      assert.equal(response.decision.taskTabAlias, 'task-tab-1');
      assert.equal(response.decision.instruction, 'Compare refundable prices');
    }
    assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 4 });
    assert.deepEqual(response.cost, {
      knowledge: 'known',
      amountUsd: 0.002,
      currency: 'USD',
    });
    assert.equal(response.resolvedProviderModelId, 'openai/gpt-5-nano');
    assert.ok(response.latencyMs >= 0);
    assert.equal(log.list()[0]?.success, true);
  });

  it('requests the autonomous task decision schema', async () => {
    const seen: GatewayStreamTextArgs[] = [];
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: (args) => {
        seen.push(args);
        return autonomousTaskDecisionStreamResult();
      },
    });

    await runtime.generateAutonomousTaskDecision(request());
    assert.equal(seen[0]?.outputSchema, 'autonomousTaskDecision');
  });

  it('rejects authority fields as MODEL_OUTPUT_INVALID', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        autonomousTaskDecisionStreamResult({
          output: settled({
            kind: 'delegate-subgoal',
            taskTabAlias: 'task-tab-1',
            instruction: 'Continue',
            approved: true,
          }),
        }),
    });

    await assert.rejects(
      () => runtime.generateAutonomousTaskDecision(request()),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
  });

  it('fails MODEL_NOT_CONFIGURED without calling the SDK when the key is missing', async () => {
    let called = false;
    const previous = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;

    try {
      const runtime = new AiSdkGatewayRuntime({
        requestLog: new ModelRequestLog(),
        streamText: () => {
          called = true;
          return autonomousTaskDecisionStreamResult();
        },
      });

      await assert.rejects(
        () => runtime.generateAutonomousTaskDecision(request()),
        (error: unknown) =>
          error instanceof ModelError && error.code === 'MODEL_NOT_CONFIGURED',
      );
      assert.equal(called, false);
    } finally {
      if (previous === undefined) {
        delete process.env.AI_GATEWAY_API_KEY;
      } else {
        process.env.AI_GATEWAY_API_KEY = previous;
      }
    }
  });

  it('fails REQUEST_CANCELLED without an SDK call when the caller signal is already aborted', async () => {
    let called = false;
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () => {
        called = true;
        return autonomousTaskDecisionStreamResult();
      },
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        runtime.generateAutonomousTaskDecision(request(), {
          signal: controller.signal,
        }),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'REQUEST_CANCELLED',
    );
    assert.equal(called, false);
  });

  it('maps abort during generation to REQUEST_CANCELLED without retrying', async () => {
    const controller = new AbortController();
    let calls = 0;
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: ({ abortSignal }) => {
        calls += 1;
        controller.abort();
        return autonomousTaskDecisionStreamResult({
          output: Promise.resolve().then(() => {
            if (abortSignal?.aborted) {
              throw abortError();
            }
            return {
              kind: 'delegate-subgoal',
              taskTabAlias: 'task-tab-1',
              instruction: 'Compare refundable prices',
            };
          }),
        });
      },
    });

    await assert.rejects(
      () =>
        runtime.generateAutonomousTaskDecision(request(), {
          signal: controller.signal,
        }),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'REQUEST_CANCELLED',
    );
    assert.equal(calls, 1);
  });
});

function workflowDraftStreamResult(
  overrides: Partial<GatewayStreamTextResult> = {},
): GatewayStreamTextResult {
  return {
    partialOutputStream: (async function* () {})(),
    output: settled({
      name: 'Status check',
      objective: 'Check the status page.',
      entryPoint: { kind: 'url', url: 'https://example.test/status' },
      trigger: { kind: 'manual' },
    }),
    usage: settled({
      inputTokens: 10,
      outputTokens: 4,
    }),
    providerMetadata: settled({ gateway: { cost: 0.002 } }),
    response: settled({ modelId: 'google/gemini-2.5-flash' }),
    ...overrides,
  };
}

describe('AiSdkGatewayRuntime.generateWorkflowDraft', () => {
  it('returns a validated workflow draft from structured output', async () => {
    const log = new ModelRequestLog();
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: log,
      streamText: () => workflowDraftStreamResult(),
    });

    const response = await runtime.generateWorkflowDraft(request());
    assert.equal(response.draft.name, 'Status check');
    assert.equal(response.draft.trigger.kind, 'manual');
    assert.equal('enabled' in response.draft, false);
    assert.equal(log.list()[0]?.success, true);
    assert.equal(log.list()[0]?.requestId, 'req-1');
  });

  it('requests the workflow draft schema with no tools', async () => {
    const seen: GatewayStreamTextArgs[] = [];
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: (args) => {
        seen.push(args);
        return workflowDraftStreamResult();
      },
    });

    await runtime.generateWorkflowDraft(request());
    assert.equal(seen[0]?.outputSchema, 'workflowDraft');
    assert.equal('tools' in (seen[0] ?? {}), false);
  });

  it('uses Output.object with maxRetries 0 and no tools in the workflow draft SDK path', () => {
    const source = readFileSync(path.join(__dirname, 'ai-sdk-gateway.ts'), 'utf8');
    const start = source.indexOf('function defaultWorkflowDraftStreamText');
    const block = source.slice(start, start + 700);
    assert.match(block, /Output\.object\(/);
    assert.match(block, /schema: WORKFLOW_DRAFT_SCHEMA/);
    assert.match(block, /maxRetries: 0/);
    assert.equal(block.includes('tools:'), false);
  });

  it('rejects unknown and authority-shaped fields as MODEL_OUTPUT_INVALID', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        workflowDraftStreamResult({
          output: settled({
            name: 'x',
            objective: 'x',
            entryPoint: { kind: 'url', url: 'https://example.test' },
            trigger: { kind: 'manual' },
            enabled: true,
            taskId: 'task-1',
          }),
        }),
    });

    await assert.rejects(
      () => runtime.generateWorkflowDraft(request()),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
  });

  it('rejects forbidden draft URLs as MODEL_OUTPUT_INVALID', async () => {
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: new ModelRequestLog(),
      streamText: () =>
        workflowDraftStreamResult({
          output: settled({
            name: 'x',
            objective: 'x',
            entryPoint: { kind: 'url', url: 'file:///tmp/secret' },
            trigger: { kind: 'manual' },
          }),
        }),
    });

    await assert.rejects(
      () => runtime.generateWorkflowDraft(request()),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
  });

  it('logs draft generation metadata without instruction, page, or draft payloads', async () => {
    const log = new ModelRequestLog();
    const runtime = new AiSdkGatewayRuntime({
      readGatewayApiKey: () => 'test-key',
      requestLog: log,
      streamText: () => workflowDraftStreamResult(),
    });
    await runtime.generateWorkflowDraft(request());
    const entry = JSON.stringify(log.list()[0]);
    assert.match(entry, /"requestId":"req-1"/);
    assert.equal(entry.includes('Status check'), false);
    assert.equal(entry.includes('USER_INSTRUCTION'), false);
    assert.equal(entry.includes('example.test'), false);
  });
});

describe('mapRuntimeError', () => {
  const idle = { callerAborted: false, timedOut: false };

  it('maps 401 and 403 to MODEL_AUTH_FAILED', () => {
    assert.equal(
      mapRuntimeError(
        new APICallError({
          message: 'unauthorized',
          url: 'https://example.invalid',
          requestBodyValues: {},
          statusCode: 401,
        }),
        idle,
      ).code,
      'MODEL_AUTH_FAILED',
    );
    assert.equal(
      mapRuntimeError(
        new APICallError({
          message: 'forbidden',
          url: 'https://example.invalid',
          requestBodyValues: {},
          statusCode: 403,
        }),
        idle,
      ).code,
      'MODEL_AUTH_FAILED',
    );
  });

  it('maps 429 to MODEL_RATE_LIMITED', () => {
    assert.equal(
      mapRuntimeError(
        new APICallError({
          message: 'limited',
          url: 'https://example.invalid',
          requestBodyValues: {},
          statusCode: 429,
        }),
        idle,
      ).code,
      'MODEL_RATE_LIMITED',
    );
  });

  it('maps unavailable model and 5xx conditions to MODEL_UNAVAILABLE', () => {
    assert.equal(
      mapRuntimeError(
        new NoSuchModelError({
          modelId: 'missing',
          modelType: 'languageModel',
        }),
        idle,
      ).code,
      'MODEL_UNAVAILABLE',
    );
    assert.equal(
      mapRuntimeError(
        new APICallError({
          message: 'bad gateway',
          url: 'https://example.invalid',
          requestBodyValues: {},
          statusCode: 503,
        }),
        idle,
      ).code,
      'MODEL_UNAVAILABLE',
    );
  });

  it('maps invalid structured output to MODEL_OUTPUT_INVALID', () => {
    assert.equal(
      mapRuntimeError(
        new NoObjectGeneratedError({
          text: '{}',
          response: { id: '1', timestamp: new Date(), modelId: 'x' },
          usage: {
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: undefined,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
          finishReason: 'stop',
        }),
        idle,
      ).code,
      'MODEL_OUTPUT_INVALID',
    );
  });

  it('maps unknown failures to MODEL_REQUEST_FAILED without leaking bodies', () => {
    const mapped = mapRuntimeError(new Error('provider body should stay internal'), idle);
    assert.equal(mapped.code, 'MODEL_REQUEST_FAILED');
    assert.equal(mapped.message, 'The model request failed.');
  });

  it('preserves an existing ModelError code', () => {
    const original = new ModelError('CONTEXT_TOO_LARGE', 'too large');
    assert.equal(mapRuntimeError(original, idle), original);
  });
});
