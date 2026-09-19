import {
  aggregateTruncatedContext,
  buildMultiTabModelMessages,
  type MultiTabObservationSource,
} from './browser-context-builder';
import type { BrowserContextBundle } from './browser-context-types';
import {
  estimateModelInputTokens,
  estimateTextInputTokens,
  modelContextFits,
} from '../ai/context-builder';
import { decideModelExport } from '../ai/export-policy';
import { MODEL_CATALOG, getModelProfile, type ModelCatalog } from '../ai/model-catalog';
import { ModelError } from '../ai/model-errors';
import { routeModelRequest } from '../ai/model-router';
import type { ModelRuntime } from '../ai/model-runtime';
import type {
  ModelAlias,
  ModelMessage,
  ModelPrivacyRequirement,
  ModelProfile,
  ModelRequest,
  ModelResponse,
} from '../ai/model-types';

const MAX_MODEL_ATTEMPTS = 2;

const FALLBACK_ELIGIBLE_CODES = new Set<ModelError['code']>([
  'MODEL_UNAVAILABLE',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_OUTPUT_INVALID',
]);

export interface MultiTabAgentRequest {
  readonly bundle: BrowserContextBundle;
  readonly question: string;
  readonly privacy?: ModelPrivacyRequirement;
  readonly abortSignal?: AbortSignal;
}

export interface MultiTabAgentAnswer {
  readonly text: string;
  readonly alias: ModelAlias;
  readonly truncatedContext: boolean;
}

export interface MultiTabAgentAnswerOptions {
  onTextDelta?: (text: string) => void;
}

export interface MultiTabReadOnlyAgentDependencies {
  observationSource: MultiTabObservationSource;
  modelRuntime: ModelRuntime;
  catalog?: ModelCatalog;
}

interface PreparedModelCall {
  profile: ModelProfile;
  messages: ModelMessage[];
  estimatedInputTokens: number;
}

type AttemptResult =
  | { ok: true; response: ModelResponse; emittedText: boolean }
  | { ok: false; error: ModelError; emittedText: boolean };

export class MultiTabReadOnlyAgent {
  private readonly modelRuntime: ModelRuntime;
  private readonly catalog: ModelCatalog;

  constructor(dependencies: MultiTabReadOnlyAgentDependencies) {
    this.modelRuntime = dependencies.modelRuntime;
    this.catalog = dependencies.catalog ?? MODEL_CATALOG;
  }

  async answer(
    request: MultiTabAgentRequest,
    options: MultiTabAgentAnswerOptions = {},
  ): Promise<MultiTabAgentAnswer> {
    if (request.abortSignal?.aborted) {
      throw cancelledError();
    }

    const privacy = request.privacy ?? 'remoteAllowed';
    const prepared = this.prepareModelCall({
      question: request.question,
      bundle: request.bundle,
      privacy,
    });

    const { response, alias } = await this.generateWithFallback({
      prepared,
      question: request.question,
      bundle: request.bundle,
      privacy,
      signal: request.abortSignal ?? new AbortController().signal,
      onTextDelta: options.onTextDelta,
    });

    return {
      text: response.text,
      alias,
      truncatedContext: aggregateTruncatedContext(request.bundle.pages),
    };
  }

  private prepareModelCall(input: {
    question: string;
    bundle: BrowserContextBundle;
    privacy: ModelPrivacyRequirement;
  }): PreparedModelCall {
    const pages = input.bundle.pages.map((page) => ({
      tabId: page.tabId,
      serializedContext: page.serializedContext,
    }));

    const probeExport = decideModelExport({
      privacy: input.privacy,
      needsVision: false,
      allowScreenshotExport: false,
      profile: { capabilities: { text: true, vision: false, structuredOutput: true, reasoning: false } },
      hasScreenshot: false,
    });
    const textMessages = buildMultiTabModelMessages({
      question: input.question,
      pages,
      exportDecision: probeExport,
    });

    let route = routeModelRequest(
      {
        taskClass: 'page_question',
        needsVision: false,
        privacy: input.privacy,
        estimatedInputTokens: estimateTextInputTokens(textMessages),
      },
      this.catalog,
    );

    let prepared = this.buildFinalCall(route.profile, input);
    if (!modelContextFits(route.profile, prepared.estimatedInputTokens)) {
      const rerouted = routeModelRequest(
        {
          taskClass: 'page_question',
          needsVision: false,
          privacy: input.privacy,
          estimatedInputTokens: prepared.estimatedInputTokens,
        },
        this.catalog,
      );
      if (rerouted.alias !== route.alias) {
        route = rerouted;
        prepared = this.buildFinalCall(route.profile, input);
      }
      if (!modelContextFits(route.profile, prepared.estimatedInputTokens)) {
        throw new ModelError(
          'CONTEXT_TOO_LARGE',
          'The final model input does not fit the selected profile.',
        );
      }
    }

    return prepared;
  }

  private buildFinalCall(
    profile: ModelProfile,
    input: {
      question: string;
      bundle: BrowserContextBundle;
      privacy: ModelPrivacyRequirement;
    },
  ): PreparedModelCall {
    const exportDecision = decideModelExport({
      privacy: input.privacy,
      needsVision: false,
      allowScreenshotExport: false,
      profile,
      hasScreenshot: false,
    });
    if (!exportDecision.structuredExportAllowed) {
      throw new ModelError(
        'MODEL_NOT_CONFIGURED',
        'Remote structured page export is not allowed.',
      );
    }

    const pages = input.bundle.pages.map((page) => ({
      tabId: page.tabId,
      serializedContext: page.serializedContext,
    }));
    const messages = buildMultiTabModelMessages({
      question: input.question,
      pages,
      exportDecision,
    });
    return {
      profile,
      messages,
      estimatedInputTokens: estimateModelInputTokens(messages),
    };
  }

  private async generateWithFallback(input: {
    prepared: PreparedModelCall;
    question: string;
    bundle: BrowserContextBundle;
    privacy: ModelPrivacyRequirement;
    signal: AbortSignal;
    onTextDelta?: (text: string) => void;
  }): Promise<{ response: ModelResponse; alias: ModelAlias }> {
    let prepared = input.prepared;
    let lastError: ModelError | undefined;

    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      const result = await this.attemptGenerate(prepared, input.signal, input.onTextDelta);
      if (result.ok) {
        return { response: result.response, alias: prepared.profile.alias };
      }
      lastError = result.error;
      throwIfCancelled(input.signal);
      if (attempt === MAX_MODEL_ATTEMPTS) {
        break;
      }
      const fallback = this.eligibleFallback(result.error, result.emittedText, {
        ...input,
        prepared,
      });
      if (!fallback) {
        break;
      }
      prepared = fallback;
    }

    throw lastError ?? cancelledError();
  }

  private eligibleFallback(
    error: ModelError,
    attempt1EmittedText: boolean,
    input: {
      question: string;
      bundle: BrowserContextBundle;
      privacy: ModelPrivacyRequirement;
      prepared: PreparedModelCall;
    },
  ): PreparedModelCall | undefined {
    if (attempt1EmittedText || !FALLBACK_ELIGIBLE_CODES.has(error.code)) {
      return undefined;
    }
    const fallbackAlias = input.prepared.profile.fallbackAlias;
    if (fallbackAlias === undefined) {
      return undefined;
    }
    const fallbackProfile = getModelProfile(fallbackAlias, this.catalog);
    const rebuilt = this.buildFinalCall(fallbackProfile, input);
    if (!modelContextFits(fallbackProfile, rebuilt.estimatedInputTokens)) {
      return undefined;
    }
    return rebuilt;
  }

  private async attemptGenerate(
    prepared: PreparedModelCall,
    signal: AbortSignal,
    onTextDelta?: (text: string) => void,
  ): Promise<AttemptResult> {
    throwIfCancelled(signal);
    const request: ModelRequest = {
      requestId: crypto.randomUUID(),
      messages: prepared.messages,
      profile: prepared.profile,
    };
    let emittedText = false;
    try {
      const response = await this.modelRuntime.generate(request, {
        signal,
        onTextDelta: (text) => {
          if (!text || signal.aborted) {
            return;
          }
          emittedText = true;
          onTextDelta?.(text);
        },
      });
      return { ok: true, response, emittedText };
    } catch (error) {
      if (error instanceof ModelError) {
        return { ok: false, error, emittedText };
      }
      throw error;
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError();
  }
}

function cancelledError(): ModelError {
  return new ModelError('REQUEST_CANCELLED', 'The request was cancelled.');
}
