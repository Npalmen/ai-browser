import {
  buildInteractiveModelMessages,
  buildInteractiveModelPageContext,
  estimateInteractiveModelInputTokens,
  type BuiltInteractiveModelPageContext,
} from './interaction-context-builder';
import { parseAgentModelOutput, type AgentModelOutput, type AgentTaskContinuation } from './interaction-output-schema';
import type { InteractionModelRuntime } from './interaction-model-runtime';
import { decideModelExport } from './export-policy';
import { MODEL_CATALOG, getModelProfile, type ModelCatalog } from './model-catalog';
import { ModelError, withModelErrorDiagnostics } from './model-errors';
import { routeModelRequest } from './model-router';
import type {
  ModelAlias,
  ModelMessage,
  ModelPrivacyRequirement,
  ModelProfile,
  ModelRequest,
  TaskClass,
} from './model-types';
import { bindInteractionProposal } from '../interaction/proposal-binder';
import type { PageObservationSource } from './read-only-agent';
import type { TabId } from '../shared/browser-types';
import type { BoundInteractionProposal } from '../shared/interaction-types';
import type {
  DocumentRevision,
  ObservePageOptions,
  PageObservation,
  TargetId,
} from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';
import { modelContextFits } from './context-builder';
import {
  serializeTrustedRunProgress,
  type TrustedRunProgressEntry,
} from './trusted-run-progress';

const MAX_OBSERVATION_ATTEMPTS = 2;
const MAX_MODEL_ATTEMPTS = 2;

const FALLBACK_ELIGIBLE_CODES = new Set<ModelError['code']>([
  'MODEL_UNAVAILABLE',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_OUTPUT_INVALID',
]);

export interface InteractiveStepAgentDependencies {
  observationSource: PageObservationSource;
  modelRuntime: InteractionModelRuntime;
  catalog?: ModelCatalog;
  allowScreenshotExport: boolean;
}

export interface InteractiveStepRequest {
  readonly tabId: TabId;
  readonly instruction: string;
  readonly taskClass?: TaskClass;
  readonly needsVision?: boolean;
  readonly privacy?: ModelPrivacyRequirement;
}

export interface InteractiveStepOptions {
  readonly signal?: AbortSignal;
  readonly onAnswerTextDelta?: (text: string) => void;
  /**
   * Trusted-main only. Supply only when ADR-006 §9 freshness is already proven.
   * Never expose this argument to renderer, model, or IPC.
   */
  readonly trustedObservation?: PageObservation;
  readonly priorConversationForRevision?: (
    tabId: TabId,
    revision: DocumentRevision,
  ) => string;
  readonly trustedProgress?: readonly TrustedRunProgressEntry[];
}

export type InteractiveStepResult =
  | {
      readonly kind: 'answer';
      readonly text: string;
      readonly referencedTargets: readonly TargetId[];
      readonly alias: ModelAlias;
      readonly truncatedContext: boolean;
      readonly observation: PageObservation;
    }
  | {
      readonly kind: 'proposal';
      readonly proposal: BoundInteractionProposal;
      readonly observation: PageObservation;
      readonly alias: ModelAlias;
      readonly truncatedContext: boolean;
      readonly continuation: AgentTaskContinuation;
      readonly onSuccessText?: string;
    };

export class InteractiveStepAgent {
  private readonly observationSource: PageObservationSource;
  private readonly modelRuntime: InteractionModelRuntime;
  private readonly catalog: ModelCatalog;
  private readonly allowScreenshotExport: boolean;

  constructor(dependencies: InteractiveStepAgentDependencies) {
    this.observationSource = dependencies.observationSource;
    this.modelRuntime = dependencies.modelRuntime;
    this.catalog = dependencies.catalog ?? MODEL_CATALOG;
    this.allowScreenshotExport = dependencies.allowScreenshotExport;
  }

  async step(
    request: InteractiveStepRequest,
    options: InteractiveStepOptions = {},
  ): Promise<InteractiveStepResult> {
    const signal = options.signal ?? new AbortController().signal;
    throwIfCancelled(signal);

    const tabId = request.tabId;
    const instruction = request.instruction;
    const taskClass = request.taskClass ?? 'page_question';
    const needsVision = request.needsVision === true;
    const privacy = request.privacy ?? 'remoteAllowed';

    const observation = await this.resolveObservation(tabId, needsVision, signal, options.trustedObservation);
    throwIfCancelled(signal);

    const builtContext = buildInteractiveModelPageContext(observation);
    const priorConversation = options.priorConversationForRevision?.(
      tabId,
      observation.document.revision,
    ) ?? '';
    const trustedProgress = serializeTrustedRunProgress(options.trustedProgress);

    const prepared = this.prepareModelCall({
      instruction,
      taskClass,
      needsVision,
      privacy,
      observation,
      builtContext,
      priorConversation,
      trustedProgress,
    });

    throwIfCancelled(signal);
    const { output, alias } = await this.generateWithFallback({
      signal,
      needsVision,
      privacy,
      observation,
      builtContext,
      priorConversation,
      trustedProgress,
      instruction,
      prepared,
      onAnswerTextDelta: options.onAnswerTextDelta,
    });

    throwIfCancelled(signal);

    if (output.kind === 'answer') {
      return {
        kind: 'answer',
        text: output.text,
        referencedTargets: filterReferencedTargets(
          output.referencedTargets,
          builtContext.exportedTargetIds,
        ),
        alias,
        truncatedContext: builtContext.context.truncated,
        observation,
      };
    }

    throwIfCancelled(signal);
    const bound = bindInteractionProposal({
      proposal: output.proposal,
      observation,
      exportedTargetIds: builtContext.exportedTargetIds,
    });
    throwIfCancelled(signal);

    return {
      kind: 'proposal',
      proposal: bound,
      observation,
      alias,
      truncatedContext: builtContext.context.truncated,
      continuation:
        output.proposal.kind === 'scroll' ? 'continue' : (output.continuation ?? 'continue'),
      ...(output.onSuccessText !== undefined ? { onSuccessText: output.onSuccessText } : {}),
    };
  }

  private async resolveObservation(
    tabId: TabId,
    needsVision: boolean,
    signal: AbortSignal,
    trustedObservation: PageObservation | undefined,
  ): Promise<PageObservation> {
    if (trustedObservation !== undefined) {
      if (trustedObservation.tabId !== tabId) {
        throw new ModelError(
          'MODEL_REQUEST_FAILED',
          'Trusted observation tab does not match the request.',
        );
      }
      if (!needsVision || trustedObservation.screenshot !== undefined) {
        return trustedObservation;
      }
    }

    return this.observeFreshPage(tabId, needsVision, signal);
  }

  private async observeFreshPage(
    tabId: TabId,
    needsVision: boolean,
    signal: AbortSignal,
  ): Promise<PageObservation> {
    const options: ObservePageOptions = { includeScreenshot: needsVision };
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_OBSERVATION_ATTEMPTS; attempt += 1) {
      throwIfCancelled(signal);
      try {
        const observation = await this.observationSource.observePage(tabId, options);
        throwIfCancelled(signal);
        return observation;
      } catch (error) {
        lastError = error;
        if (error instanceof ObservationError && error.code === 'TAB_NOT_FOUND') {
          throw error;
        }
        const retryStale =
          error instanceof ObservationError &&
          error.code === 'PAGE_CHANGED_DURING_OBSERVATION' &&
          attempt < MAX_OBSERVATION_ATTEMPTS;
        if (!retryStale) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private prepareModelCall(input: {
    instruction: string;
    taskClass: TaskClass;
    needsVision: boolean;
    privacy: ModelPrivacyRequirement;
    observation: PageObservation;
    builtContext: BuiltInteractiveModelPageContext;
    priorConversation: string;
    trustedProgress: string | undefined;
  }): PreparedModelCall {
    const textMessages = buildInteractiveModelMessages({
      instruction: input.instruction,
      serializedPageContext: input.builtContext.serialized,
      priorConversation: input.priorConversation || undefined,
      trustedProgress: input.trustedProgress,
      exportDecision: decideModelExport({
        privacy: input.privacy,
        needsVision: false,
        allowScreenshotExport: false,
        profile: { capabilities: { text: true, vision: false, structuredOutput: true, reasoning: false } },
        hasScreenshot: false,
      }),
    });

    let route = routeModelRequest(
      {
        taskClass: input.taskClass,
        needsVision: input.needsVision,
        privacy: input.privacy,
        estimatedInputTokens: estimateInteractiveModelInputTokens(textMessages),
      },
      this.catalog,
    );

    let prepared = this.buildFinalCall(route.profile, input);
    if (!modelContextFits(route.profile, prepared.estimatedInputTokens)) {
      const rerouted = routeModelRequest(
        {
          taskClass: input.taskClass,
          needsVision: input.needsVision,
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
      instruction: string;
      needsVision: boolean;
      privacy: ModelPrivacyRequirement;
      observation: PageObservation;
      builtContext: BuiltInteractiveModelPageContext;
      priorConversation: string;
      trustedProgress: string | undefined;
    },
  ): PreparedModelCall {
    const exportDecision = decideModelExport({
      privacy: input.privacy,
      needsVision: input.needsVision,
      allowScreenshotExport: this.allowScreenshotExport,
      profile,
      hasScreenshot: input.observation.screenshot !== undefined,
    });
    const screenshot =
      exportDecision.screenshotExportAllowed && input.observation.screenshot
        ? {
            mimeType: input.observation.screenshot.mimeType,
            data: input.observation.screenshot.data,
          }
        : undefined;
    const messages = buildInteractiveModelMessages({
      instruction: input.instruction,
      serializedPageContext: input.builtContext.serialized,
      priorConversation: input.priorConversation || undefined,
      trustedProgress: input.trustedProgress,
      exportDecision,
      screenshot,
    });
    return {
      profile,
      messages,
      estimatedInputTokens: estimateInteractiveModelInputTokens(messages),
    };
  }

  private async generateWithFallback(input: {
    signal: AbortSignal;
    needsVision: boolean;
    privacy: ModelPrivacyRequirement;
    observation: PageObservation;
    builtContext: BuiltInteractiveModelPageContext;
    priorConversation: string;
    trustedProgress: string | undefined;
    instruction: string;
    prepared: PreparedModelCall;
    onAnswerTextDelta?: (text: string) => void;
  }): Promise<{ output: AgentModelOutput; alias: ModelAlias }> {
    let prepared = input.prepared;
    let lastError: ModelError | undefined;
    let fallbackAttempts = 0;

    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      const result = await this.attemptGenerate(prepared, input.signal, input.onAnswerTextDelta);
      if (result.ok) {
        return { output: result.output, alias: prepared.profile.alias };
      }
      lastError = result.error;
      throwIfCancelled(input.signal);
      if (attempt === MAX_MODEL_ATTEMPTS) {
        break;
      }
      const fallback = this.eligibleFallback(result.error, result.emittedAnswerText, {
        ...input,
        prepared,
      });
      if (!fallback) {
        break;
      }
      fallbackAttempts += 1;
      prepared = fallback;
    }

    throw withModelErrorDiagnostics(lastError ?? cancelledError(), {
      alias: prepared.profile.alias,
      fallbackAttempts,
    });
  }

  private eligibleFallback(
    error: ModelError,
    attempt1EmittedAnswerText: boolean,
    input: {
      needsVision: boolean;
      privacy: ModelPrivacyRequirement;
      observation: PageObservation;
      builtContext: BuiltInteractiveModelPageContext;
      priorConversation: string;
      trustedProgress: string | undefined;
      instruction: string;
      prepared: PreparedModelCall;
    },
  ): PreparedModelCall | undefined {
    if (attempt1EmittedAnswerText || !FALLBACK_ELIGIBLE_CODES.has(error.code)) {
      return undefined;
    }
    const fallbackAlias = input.prepared.profile.fallbackAlias;
    if (fallbackAlias === undefined) {
      return undefined;
    }
    const fallbackProfile = getModelProfile(fallbackAlias, this.catalog);
    if (!profileSupportsRequest(fallbackProfile, input.needsVision)) {
      return undefined;
    }
    const rebuilt = this.buildFinalCall(fallbackProfile, input);
    if (!modelContextFits(fallbackProfile, rebuilt.estimatedInputTokens)) {
      return undefined;
    }
    return rebuilt;
  }

  private async attemptGenerate(
    prepared: PreparedModelCall,
    signal: AbortSignal,
    onAnswerTextDelta?: (text: string) => void,
  ): Promise<AttemptResult> {
    throwIfCancelled(signal);
    const request: ModelRequest = {
      requestId: crypto.randomUUID(),
      messages: prepared.messages,
      profile: prepared.profile,
    };
    let emittedAnswerText = false;
    try {
      const response = await this.modelRuntime.generateInteraction(request, {
        signal,
        onAnswerTextDelta: (text) => {
          if (!text) {
            return;
          }
          if (signal.aborted) {
            return;
          }
          emittedAnswerText = true;
          onAnswerTextDelta?.(text);
        },
      });
      throwIfCancelled(signal);
      const output = parseAgentModelOutput(response.output);
      if (emittedAnswerText && output.kind === 'interaction') {
        return {
          ok: false,
          error: new ModelError(
            'MODEL_OUTPUT_INVALID',
            'The model output changed from streamed answer text to an interaction proposal.',
          ),
          emittedAnswerText: true,
        };
      }
      throwIfCancelled(signal);
      return { ok: true, output, emittedAnswerText };
    } catch (error) {
      if (error instanceof ModelError) {
        return { ok: false, error, emittedAnswerText };
      }
      throw error;
    }
  }
}

interface PreparedModelCall {
  profile: ModelProfile;
  messages: ModelMessage[];
  estimatedInputTokens: number;
}

type AttemptResult =
  | { ok: true; output: AgentModelOutput; emittedAnswerText: boolean }
  | { ok: false; error: ModelError; emittedAnswerText: boolean };

function profileSupportsRequest(profile: ModelProfile, needsVision: boolean): boolean {
  if (profile.capabilities.text !== true) {
    return false;
  }
  if (needsVision && profile.capabilities.vision !== true) {
    return false;
  }
  return true;
}

function filterReferencedTargets(
  referencedTargets: TargetId[],
  exportedTargetIds: ReadonlySet<TargetId>,
): TargetId[] {
  const seen = new Set<TargetId>();
  const filtered: TargetId[] = [];
  for (const targetId of referencedTargets) {
    if (!exportedTargetIds.has(targetId) || seen.has(targetId)) {
      continue;
    }
    seen.add(targetId);
    filtered.push(targetId);
  }
  return filtered;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError();
  }
}

function cancelledError(): ModelError {
  return new ModelError('REQUEST_CANCELLED', 'The request was cancelled.');
}
