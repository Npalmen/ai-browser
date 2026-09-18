import {
  APICallError,
  jsonSchema,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  NoSuchModelError,
  Output,
  streamText,
  StreamProviderError,
  TypeValidationError,
  type JSONSchema7,
  type ModelMessage as SdkModelMessage,
} from 'ai';

import {
  AGENT_MODEL_OUTPUT_JSON_SCHEMA,
  parseAgentModelOutput,
  type AgentModelOutput,
} from '../interaction-output-schema';
import type {
  AutonomousTaskPlannerResponse,
  AutonomousTaskPlannerRuntime,
} from '../../autonomous-task/autonomous-task-planner-runtime';
import {
  AUTONOMOUS_TASK_DECISION_JSON_SCHEMA,
  parseAutonomousTaskDecision,
  type AutonomousTaskDecision,
} from '../../autonomous-task/autonomous-task-decision';
import type {
  InteractionModelResponse,
  InteractionModelRuntime,
} from '../interaction-model-runtime';
import { getGatewayCatalogMetadata } from '../model-catalog';
import { ModelError } from '../model-errors';
import type { ModelRuntime } from '../model-runtime';
import type {
  ModelMessage,
  ModelProfile,
  ModelRequest,
  ModelResponse,
} from '../model-types';
import { modelRequestLog, type ModelRequestLog } from '../request-log';
import { normalizeGatewayCost, normalizeModelUsage } from '../usage';

interface PageAnswer {
  text: string;
  referencedTargets: string[];
}

const PAGE_ANSWER_JSON_SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    referencedTargets: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['text', 'referencedTargets'],
};

function validatePageAnswer(
  value: unknown,
): { success: true; value: PageAnswer } | { success: false; error: Error } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { success: false, error: new Error('Expected an object.') };
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') {
    return { success: false, error: new Error('text must be a string.') };
  }
  if (
    !Array.isArray(record.referencedTargets) ||
    !record.referencedTargets.every((item) => typeof item === 'string')
  ) {
    return {
      success: false,
      error: new Error('referencedTargets must be an array of strings.'),
    };
  }

  return {
    success: true,
    value: {
      text: record.text,
      referencedTargets: record.referencedTargets,
    },
  };
}

const PAGE_ANSWER_SCHEMA = jsonSchema<PageAnswer>(PAGE_ANSWER_JSON_SCHEMA, {
  validate: validatePageAnswer,
});

const AGENT_MODEL_OUTPUT_SCHEMA = jsonSchema<AgentModelOutput>(
  AGENT_MODEL_OUTPUT_JSON_SCHEMA as unknown as JSONSchema7,
  {
    validate: (value: unknown) => {
      try {
        const parsed = parseAgentModelOutput(value);
        return { success: true as const, value: parsed };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Invalid model output.';
        return { success: false as const, error: new Error(message) };
      }
    },
  },
);

const AUTONOMOUS_TASK_DECISION_SCHEMA = jsonSchema<AutonomousTaskDecision>(
  AUTONOMOUS_TASK_DECISION_JSON_SCHEMA as unknown as JSONSchema7,
  {
    validate: (value: unknown) => {
      try {
        const parsed = parseAutonomousTaskDecision(value);
        return { success: true as const, value: parsed };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Invalid planner output.';
        return { success: false as const, error: new Error(message) };
      }
    },
  },
);

export interface GatewayStreamTextArgs {
  model: string;
  messages: SdkModelMessage[];
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  providerOptions?: {
    gateway: {
      sort: 'cost' | 'ttft' | 'tps';
    };
  };
  outputSchema?: 'pageAnswer' | 'agentModelOutput' | 'autonomousTaskDecision';
}

export interface GatewayStreamTextResult {
  partialOutputStream: AsyncIterable<unknown>;
  output: PromiseLike<unknown>;
  usage: PromiseLike<unknown>;
  providerMetadata: PromiseLike<unknown>;
  response: PromiseLike<unknown>;
}

export type GatewayStreamText = (args: GatewayStreamTextArgs) => GatewayStreamTextResult;

export interface AiSdkGatewayRuntimeOptions {
  streamText?: GatewayStreamText;
  readGatewayApiKey?: () => string | undefined;
  createTimeoutSignal?: (ms: number) => AbortSignal;
  now?: () => number;
  requestLog?: ModelRequestLog;
}

function defaultStreamText(args: GatewayStreamTextArgs): GatewayStreamTextResult {
  if (args.outputSchema === 'agentModelOutput') {
    return defaultAgentModelOutputStreamText(args);
  }
  if (args.outputSchema === 'autonomousTaskDecision') {
    return defaultAutonomousTaskDecisionStreamText(args);
  }
  return defaultPageAnswerStreamText(args);
}

function defaultPageAnswerStreamText(args: GatewayStreamTextArgs): GatewayStreamTextResult {
  const result = streamText({
    model: args.model,
    messages: args.messages,
    maxOutputTokens: args.maxOutputTokens,
    abortSignal: args.abortSignal,
    providerOptions: args.providerOptions,
    output: Output.object({
      schema: PAGE_ANSWER_SCHEMA,
      name: 'pageAnswer',
    }),
    allowSystemInMessages: true,
    maxRetries: 0,
  });

  return {
    partialOutputStream: result.partialOutputStream,
    output: result.output,
    usage: result.usage,
    providerMetadata: result.providerMetadata,
    response: result.response,
  };
}

function defaultAgentModelOutputStreamText(args: GatewayStreamTextArgs): GatewayStreamTextResult {
  const result = streamText({
    model: args.model,
    messages: args.messages,
    maxOutputTokens: args.maxOutputTokens,
    abortSignal: args.abortSignal,
    providerOptions: args.providerOptions,
    output: Output.object({
      schema: AGENT_MODEL_OUTPUT_SCHEMA,
      name: 'agentModelOutput',
    }),
    allowSystemInMessages: true,
    maxRetries: 0,
  });

  return {
    partialOutputStream: result.partialOutputStream,
    output: result.output,
    usage: result.usage,
    providerMetadata: result.providerMetadata,
    response: result.response,
  };
}

function defaultAutonomousTaskDecisionStreamText(args: GatewayStreamTextArgs): GatewayStreamTextResult {
  const result = streamText({
    model: args.model,
    messages: args.messages,
    maxOutputTokens: args.maxOutputTokens,
    abortSignal: args.abortSignal,
    providerOptions: args.providerOptions,
    output: Output.object({
      schema: AUTONOMOUS_TASK_DECISION_SCHEMA,
      name: 'autonomousTaskDecision',
    }),
    allowSystemInMessages: true,
    maxRetries: 0,
  });

  return {
    partialOutputStream: result.partialOutputStream,
    output: result.output,
    usage: result.usage,
    providerMetadata: result.providerMetadata,
    response: result.response,
  };
}

function readProcessGatewayApiKey(): string | undefined {
  return process.env.AI_GATEWAY_API_KEY;
}

function isUsableApiKey(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export class AiSdkGatewayRuntime
  implements ModelRuntime, InteractionModelRuntime, AutonomousTaskPlannerRuntime
{
  private readonly streamText: GatewayStreamText;
  private readonly readGatewayApiKey: () => string | undefined;
  private readonly createTimeoutSignal: (ms: number) => AbortSignal;
  private readonly now: () => number;
  private readonly requestLog: ModelRequestLog;

  constructor(options: AiSdkGatewayRuntimeOptions = {}) {
    this.streamText = options.streamText ?? defaultStreamText;
    this.readGatewayApiKey = options.readGatewayApiKey ?? readProcessGatewayApiKey;
    this.createTimeoutSignal = options.createTimeoutSignal ?? AbortSignal.timeout;
    this.now = options.now ?? Date.now;
    this.requestLog = options.requestLog ?? modelRequestLog;
  }

  async generate(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
      onTextDelta?: (text: string) => void;
    },
  ): Promise<ModelResponse> {
    const startedAt = this.now();
    const alias = request.profile.alias;
    let modelStartedAt: number | undefined;
    let timeoutSignal: AbortSignal | undefined;

    try {
      if (!isUsableApiKey(this.readGatewayApiKey())) {
        throw new ModelError(
          'MODEL_NOT_CONFIGURED',
          'AI Gateway is not configured.',
        );
      }

      if (options?.signal?.aborted) {
        throw new ModelError(
          'REQUEST_CANCELLED',
          'The model request was cancelled.',
        );
      }

      const messages = toSdkMessages(request.messages);
      timeoutSignal = this.createTimeoutSignal(request.profile.requestTimeoutMs);
      const abortSignal = combineAbortSignals(options?.signal, timeoutSignal);
      const providerOptions = gatewayProviderOptions(request.profile);

      modelStartedAt = this.now();
      const result = this.streamText({
        model: request.profile.providerModelId,
        messages,
        maxOutputTokens: request.profile.maxOutputTokens,
        abortSignal,
        providerOptions,
      });

      await emitTextDeltas(result.partialOutputStream, options?.onTextDelta);

      const output = asPageAnswer(await result.output);
      const usage = normalizeModelUsage(await result.usage);
      const cost = normalizeGatewayCost(await result.providerMetadata);
      const resolvedProviderModelId = resolveProviderModelId(
        await result.response,
        request.profile.providerModelId,
      );
      const latencyMs = elapsedMs(modelStartedAt, this.now());

      this.requestLog.append({
        requestId: request.requestId,
        startedAt,
        alias,
        resolvedProviderModelId,
        latencyMs,
        usage,
        cost,
        success: true,
      });

      return {
        text: output.text,
        referencedTargets: output.referencedTargets,
        usage,
        cost,
        resolvedProviderModelId,
        latencyMs,
      };
    } catch (error) {
      const mapped = mapRuntimeError(error, {
        callerAborted: Boolean(options?.signal?.aborted),
        timedOut: Boolean(timeoutSignal?.aborted && !options?.signal?.aborted),
      });

      const latencyMs =
        modelStartedAt === undefined ? undefined : elapsedMs(modelStartedAt, this.now());

      this.requestLog.append({
        requestId: request.requestId,
        startedAt,
        alias,
        latencyMs,
        success: false,
        errorCode: mapped.code,
      });

      throw mapped;
    }
  }

  async generateInteraction(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
      onAnswerTextDelta?: (text: string) => void;
    },
  ): Promise<InteractionModelResponse> {
    const startedAt = this.now();
    const alias = request.profile.alias;
    let modelStartedAt: number | undefined;
    let timeoutSignal: AbortSignal | undefined;

    try {
      if (!isUsableApiKey(this.readGatewayApiKey())) {
        throw new ModelError(
          'MODEL_NOT_CONFIGURED',
          'AI Gateway is not configured.',
        );
      }

      if (options?.signal?.aborted) {
        throw new ModelError(
          'REQUEST_CANCELLED',
          'The model request was cancelled.',
        );
      }

      const messages = toSdkMessages(request.messages);
      timeoutSignal = this.createTimeoutSignal(request.profile.requestTimeoutMs);
      const abortSignal = combineAbortSignals(options?.signal, timeoutSignal);
      const providerOptions = gatewayProviderOptions(request.profile);

      modelStartedAt = this.now();
      const result = this.streamText({
        model: request.profile.providerModelId,
        messages,
        maxOutputTokens: request.profile.maxOutputTokens,
        abortSignal,
        providerOptions,
        outputSchema: 'agentModelOutput',
      });

      await emitAnswerTextDeltas(result.partialOutputStream, options?.onAnswerTextDelta);

      const output = asAgentModelOutput(await result.output);
      const usage = normalizeModelUsage(await result.usage);
      const cost = normalizeGatewayCost(await result.providerMetadata);
      const resolvedProviderModelId = resolveProviderModelId(
        await result.response,
        request.profile.providerModelId,
      );
      const latencyMs = elapsedMs(modelStartedAt, this.now());

      this.requestLog.append({
        requestId: request.requestId,
        startedAt,
        alias,
        resolvedProviderModelId,
        latencyMs,
        usage,
        cost,
        success: true,
      });

      return {
        output,
        usage,
        cost,
        resolvedProviderModelId,
        latencyMs,
      };
    } catch (error) {
      const mapped = mapRuntimeError(error, {
        callerAborted: Boolean(options?.signal?.aborted),
        timedOut: Boolean(timeoutSignal?.aborted && !options?.signal?.aborted),
      });

      const latencyMs =
        modelStartedAt === undefined ? undefined : elapsedMs(modelStartedAt, this.now());

      this.requestLog.append({
        requestId: request.requestId,
        startedAt,
        alias,
        latencyMs,
        success: false,
        errorCode: mapped.code,
      });

      throw mapped;
    }
  }

  async generateAutonomousTaskDecision(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<AutonomousTaskPlannerResponse> {
    const startedAt = this.now();
    const alias = request.profile.alias;
    let modelStartedAt: number | undefined;
    let timeoutSignal: AbortSignal | undefined;

    try {
      if (!isUsableApiKey(this.readGatewayApiKey())) {
        throw new ModelError(
          'MODEL_NOT_CONFIGURED',
          'AI Gateway is not configured.',
        );
      }

      if (options?.signal?.aborted) {
        throw new ModelError(
          'REQUEST_CANCELLED',
          'The model request was cancelled.',
        );
      }

      const messages = toSdkMessages(request.messages);
      timeoutSignal = this.createTimeoutSignal(request.profile.requestTimeoutMs);
      const abortSignal = combineAbortSignals(options?.signal, timeoutSignal);
      const providerOptions = gatewayProviderOptions(request.profile);

      modelStartedAt = this.now();
      const result = this.streamText({
        model: request.profile.providerModelId,
        messages,
        maxOutputTokens: request.profile.maxOutputTokens,
        abortSignal,
        providerOptions,
        outputSchema: 'autonomousTaskDecision',
      });

      const decision = asAutonomousTaskDecision(await result.output);
      const usage = normalizeModelUsage(await result.usage);
      const cost = normalizeGatewayCost(await result.providerMetadata);
      const resolvedProviderModelId = resolveProviderModelId(
        await result.response,
        request.profile.providerModelId,
      );
      const latencyMs = elapsedMs(modelStartedAt, this.now());

      this.requestLog.append({
        requestId: request.requestId,
        startedAt,
        alias,
        resolvedProviderModelId,
        latencyMs,
        usage,
        cost,
        success: true,
      });

      return {
        decision,
        usage,
        cost,
        resolvedProviderModelId,
        latencyMs,
      };
    } catch (error) {
      const mapped = mapRuntimeError(error, {
        callerAborted: Boolean(options?.signal?.aborted),
        timedOut: Boolean(timeoutSignal?.aborted && !options?.signal?.aborted),
      });

      const latencyMs =
        modelStartedAt === undefined ? undefined : elapsedMs(modelStartedAt, this.now());

      this.requestLog.append({
        requestId: request.requestId,
        startedAt,
        alias,
        latencyMs,
        success: false,
        errorCode: mapped.code,
      });

      throw mapped;
    }
  }
}

function gatewayProviderOptions(
  profile: ModelProfile,
): GatewayStreamTextArgs['providerOptions'] {
  const sort = getGatewayCatalogMetadata(profile.alias).sort;
  if (sort === undefined) {
    return undefined;
  }
  return { gateway: { sort } };
}

export function toSdkMessages(messages: ModelMessage[]): SdkModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'system') {
      if (message.content.some((part) => part.type === 'image')) {
        throw new ModelError(
          'MODEL_REQUEST_FAILED',
          'System messages cannot include images.',
        );
      }
      return {
        role: 'system',
        content: message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      };
    }

    return {
      role: 'user',
      content: message.content.map((part) => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text };
        }
        return {
          type: 'file' as const,
          mediaType: 'image/jpeg' as const,
          data: part.dataBase64,
        };
      }),
    };
  });
}

function combineAbortSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
}

async function emitTextDeltas(
  partials: AsyncIterable<unknown>,
  onTextDelta: ((text: string) => void) | undefined,
): Promise<void> {
  let previous = '';
  for await (const partial of partials) {
    if (onTextDelta === undefined) {
      continue;
    }
    const current = asRecord(partial)?.text;
    if (typeof current !== 'string' || !current.startsWith(previous)) {
      continue;
    }
    const delta = current.slice(previous.length);
    if (delta.length > 0) {
      onTextDelta(delta);
    }
    previous = current;
  }
}

async function emitAnswerTextDeltas(
  partials: AsyncIterable<unknown>,
  onAnswerTextDelta: ((text: string) => void) | undefined,
): Promise<void> {
  let previous = '';
  for await (const partial of partials) {
    if (onAnswerTextDelta === undefined) {
      continue;
    }
    const record = asRecord(partial);
    if (record?.kind !== 'answer') {
      continue;
    }
    const current = record.text;
    if (typeof current !== 'string' || !current.startsWith(previous)) {
      continue;
    }
    const delta = current.slice(previous.length);
    if (delta.length > 0) {
      onAnswerTextDelta(delta);
    }
    previous = current;
  }
}

function asPageAnswer(value: unknown): PageAnswer {
  const validated = validatePageAnswer(value);
  if (!validated.success) {
    throw new ModelError(
      'MODEL_OUTPUT_INVALID',
      'The model output was invalid.',
      { cause: validated.error },
    );
  }
  return validated.value;
}

function asAgentModelOutput(value: unknown): AgentModelOutput {
  return parseAgentModelOutput(value);
}

function asAutonomousTaskDecision(value: unknown): AutonomousTaskDecision {
  return parseAutonomousTaskDecision(value);
}

function resolveProviderModelId(response: unknown, fallback: string): string {
  const modelId = asRecord(response)?.modelId;
  return typeof modelId === 'string' && modelId.trim() !== '' ? modelId : fallback;
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isAbortLike(error: unknown): boolean {
  return (
    (error instanceof Error ||
      (typeof DOMException === 'function' && error instanceof DOMException)) &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'ResponseAborted')
  );
}

function statusCodeOf(error: unknown): number | undefined {
  if (APICallError.isInstance(error) || StreamProviderError.isInstance(error)) {
    return error.statusCode;
  }
  const statusCode = asRecord(error)?.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

export function mapRuntimeError(
  error: unknown,
  context: {
    callerAborted: boolean;
    timedOut: boolean;
  },
): ModelError {
  if (error instanceof ModelError) {
    return error;
  }

  if (context.callerAborted) {
    return new ModelError('REQUEST_CANCELLED', 'The model request was cancelled.', {
      cause: error,
    });
  }

  if (context.timedOut) {
    return new ModelError('MODEL_TIMEOUT', 'The model request timed out.', { cause: error });
  }

  if (LoadAPIKeyError.isInstance(error)) {
    return new ModelError('MODEL_NOT_CONFIGURED', 'AI Gateway is not configured.', {
      cause: error,
    });
  }

  if (
    NoObjectGeneratedError.isInstance(error) ||
    TypeValidationError.isInstance(error)
  ) {
    return new ModelError('MODEL_OUTPUT_INVALID', 'The model output was invalid.', {
      cause: error,
    });
  }

  if (NoSuchModelError.isInstance(error)) {
    return new ModelError('MODEL_UNAVAILABLE', 'The model is unavailable.', { cause: error });
  }

  const statusCode = statusCodeOf(error);

  if (statusCode === 401 || statusCode === 403) {
    return new ModelError(
      'MODEL_AUTH_FAILED',
      'The model request was not authorized.',
      { cause: error },
    );
  }

  if (statusCode === 429) {
    return new ModelError('MODEL_RATE_LIMITED', 'The model is rate limited.', {
      cause: error,
    });
  }

  if (statusCode === 408 || statusCode === 504) {
    return new ModelError('MODEL_TIMEOUT', 'The model request timed out.', { cause: error });
  }

  if (
    statusCode === 404 ||
    (typeof statusCode === 'number' && statusCode >= 500 && statusCode <= 599)
  ) {
    return new ModelError('MODEL_UNAVAILABLE', 'The model is unavailable.', { cause: error });
  }

  if (isAbortLike(error)) {
    return new ModelError('REQUEST_CANCELLED', 'The model request was cancelled.', {
      cause: error,
    });
  }

  return new ModelError('MODEL_REQUEST_FAILED', 'The model request failed.', {
    cause: error,
  });
}
