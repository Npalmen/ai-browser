import {
  buildInteractiveModelMessages,
  buildInteractiveModelPageContext,
  estimateInteractiveModelInputTokens,
  type BuiltInteractiveModelPageContext,
} from './interaction-context-builder';
import { parseAgentModelOutput, type AgentModelOutput } from './interaction-output-schema';
import type { InteractionModelRuntime } from './interaction-model-runtime';
import { ConversationStore } from './conversation-store';
import { decideModelExport } from './export-policy';
import { MODEL_CATALOG, getModelProfile, type ModelCatalog } from './model-catalog';
import { ModelError } from './model-errors';
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
import type { BoundInteractionProposal, InteractionResult } from '../shared/interaction-types';
import type {
  ObservePageOptions,
  PageObservation,
  TargetId,
} from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';
import { modelContextFits } from './context-builder';

const MAX_OBSERVATION_ATTEMPTS = 2;
const MAX_MODEL_ATTEMPTS = 2;

const FALLBACK_ELIGIBLE_CODES = new Set<ModelError['code']>([
  'MODEL_UNAVAILABLE',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_OUTPUT_INVALID',
]);

export interface InteractionExecutionPort {
  execute(input: {
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): Promise<InteractionResult>;
}

export interface InteractiveAgentRequest {
  tabId: TabId;
  instruction: string;
  taskClass?: TaskClass;
  needsVision?: boolean;
  privacy?: ModelPrivacyRequirement;
  abortSignal?: AbortSignal;
}

export type InteractiveAgentResult =
  | {
      kind: 'answer';
      text: string;
      referencedTargets: TargetId[];
      alias: ModelAlias;
      truncatedContext: boolean;
    }
  | {
      kind: 'interaction';
      result: InteractionResult;
      alias: ModelAlias;
      truncatedContext: boolean;
    };

export interface InteractiveAgentOptions {
  onAnswerTextDelta?: (text: string) => void;
}

export interface InteractiveAgentDependencies {
  observationSource: PageObservationSource;
  modelRuntime: InteractionModelRuntime;
  interactionExecutor: InteractionExecutionPort;
  catalog?: ModelCatalog;
  allowScreenshotExport: boolean;
}

export class InteractiveAgent {
  private readonly observationSource: PageObservationSource;
  private readonly modelRuntime: InteractionModelRuntime;
  private readonly interactionExecutor: InteractionExecutionPort;
  private readonly catalog: ModelCatalog;
  private readonly allowScreenshotExport: boolean;
  private readonly conversations: ConversationStore;
  private readonly latestGeneration = new Map<TabId, number>();
  private readonly controllers = new Map<TabId, AbortController>();
  private readonly tails = new Map<TabId, Promise<void>>();

  constructor(dependencies: InteractiveAgentDependencies) {
    this.observationSource = dependencies.observationSource;
    this.modelRuntime = dependencies.modelRuntime;
    this.interactionExecutor = dependencies.interactionExecutor;
    this.catalog = dependencies.catalog ?? MODEL_CATALOG;
    this.allowScreenshotExport = dependencies.allowScreenshotExport;
    this.conversations = new ConversationStore();
  }

  async interact(
    request: InteractiveAgentRequest,
    options: InteractiveAgentOptions = {},
  ): Promise<InteractiveAgentResult> {
    if (request.abortSignal?.aborted) {
      throw cancelledError();
    }

    const tabId = request.tabId;
    const generation = (this.latestGeneration.get(tabId) ?? 0) + 1;
    this.latestGeneration.set(tabId, generation);

    this.controllers.get(tabId)?.abort();
    const controller = new AbortController();
    this.controllers.set(tabId, controller);
    linkExternalAbort(controller, request.abortSignal);

    const previous = this.tails.get(tabId) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      tabId,
      previous.then(
        () => mine,
        () => mine,
      ),
    );

    try {
      await previous;
      throwIfCancelled(controller.signal);
      if (this.latestGeneration.get(tabId) !== generation) {
        throw cancelledError();
      }

      return await this.executeInteract({
        tabId,
        instruction: request.instruction,
        taskClass: request.taskClass ?? 'page_question',
        needsVision: request.needsVision === true,
        privacy: request.privacy ?? 'remoteAllowed',
        generation,
        signal: controller.signal,
        onAnswerTextDelta: options.onAnswerTextDelta,
      });
    } finally {
      if (this.controllers.get(tabId) === controller) {
        this.controllers.delete(tabId);
      }
      if (this.latestGeneration.get(tabId) === generation) {
        this.tails.delete(tabId);
      }
      release();
    }
  }

  cancel(tabId: TabId): boolean {
    const controller = this.controllers.get(tabId);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort();
    return true;
  }

  clearConversation(tabId: TabId): void {
    this.conversations.clear(tabId);
  }

  clearAllConversations(): void {
    this.conversations.clearAll();
  }

  private async executeInteract(input: {
    tabId: TabId;
    instruction: string;
    taskClass: TaskClass;
    needsVision: boolean;
    privacy: ModelPrivacyRequirement;
    generation: number;
    signal: AbortSignal;
    onAnswerTextDelta?: (text: string) => void;
  }): Promise<InteractiveAgentResult> {
    throwIfCancelled(input.signal);
    const observation = await this.observeFreshPage(input.tabId, input.needsVision, input.signal);
    throwIfCancelled(input.signal);

    const builtContext = buildInteractiveModelPageContext(observation);
    const priorConversation = this.conversations.serializeForRevision(
      input.tabId,
      observation.document.revision,
    );

    const prepared = this.prepareModelCall({
      instruction: input.instruction,
      taskClass: input.taskClass,
      needsVision: input.needsVision,
      privacy: input.privacy,
      observation,
      builtContext,
      priorConversation,
    });

    throwIfCancelled(input.signal);
    const { output, alias } = await this.generateWithFallback({
      tabId: input.tabId,
      generation: input.generation,
      signal: input.signal,
      needsVision: input.needsVision,
      privacy: input.privacy,
      observation,
      builtContext,
      priorConversation,
      instruction: input.instruction,
      prepared,
      onAnswerTextDelta: input.onAnswerTextDelta,
    });

    throwIfCancelled(input.signal);
    if (this.latestGeneration.get(input.tabId) !== input.generation) {
      throw cancelledError();
    }

    if (output.kind === 'answer') {
      const referencedTargets = filterReferencedTargets(
        output.referencedTargets,
        builtContext.exportedTargetIds,
      );
      this.conversations.commitTurn(input.tabId, observation.document.revision, {
        question: input.instruction,
        answer: output.text,
      });
      return {
        kind: 'answer',
        text: output.text,
        referencedTargets,
        alias,
        truncatedContext: builtContext.context.truncated,
      };
    }

    throwIfCancelled(input.signal);
    const bound = bindInteractionProposal({
      proposal: output.proposal,
      observation,
      exportedTargetIds: builtContext.exportedTargetIds,
    });

    throwIfCancelled(input.signal);
    const result = await this.interactionExecutor.execute({
      proposal: bound,
      observation,
      signal: input.signal,
    });

    this.conversations.commitTurn(input.tabId, observation.document.revision, {
      question: input.instruction,
      answer: summarizeInteractionResult(output.proposal.kind, result),
    });

    return {
      kind: 'interaction',
      result,
      alias,
      truncatedContext: builtContext.context.truncated,
    };
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
          this.conversations.clear(tabId);
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
  }): PreparedModelCall {
    const textMessages = buildInteractiveModelMessages({
      instruction: input.instruction,
      serializedPageContext: input.builtContext.serialized,
      priorConversation: input.priorConversation || undefined,
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
    tabId: TabId;
    generation: number;
    signal: AbortSignal;
    needsVision: boolean;
    privacy: ModelPrivacyRequirement;
    observation: PageObservation;
    builtContext: BuiltInteractiveModelPageContext;
    priorConversation: string;
    instruction: string;
    prepared: PreparedModelCall;
    onAnswerTextDelta?: (text: string) => void;
  }): Promise<{ output: AgentModelOutput; alias: ModelAlias }> {
    let prepared = input.prepared;
    let lastError: ModelError | undefined;

    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      const result = await this.attemptGenerate(
        prepared,
        input.signal,
        input.tabId,
        input.generation,
        input.onAnswerTextDelta,
      );
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
      prepared = fallback;
    }

    throw lastError ?? cancelledError();
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
    tabId: TabId,
    generation: number,
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
          if (this.latestGeneration.get(tabId) !== generation || signal.aborted) {
            return;
          }
          emittedAnswerText = true;
          onAnswerTextDelta?.(text);
        },
      });
      const output = parseAgentModelOutput(response.output);
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

function summarizeInteractionResult(
  proposalKind: string,
  result: InteractionResult,
): string {
  if (result.status === 'succeeded') {
    return `[interaction ${proposalKind} succeeded]`;
  }
  if (result.status === 'denied') {
    return `[interaction ${proposalKind} denied]`;
  }
  return `[interaction ${proposalKind} failed]`;
}

function linkExternalAbort(controller: AbortController, external?: AbortSignal): void {
  if (!external) {
    return;
  }
  if (external.aborted) {
    controller.abort();
    return;
  }
  external.addEventListener(
    'abort',
    () => {
      controller.abort();
    },
    { once: true },
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError();
  }
}

function cancelledError(): ModelError {
  return new ModelError('REQUEST_CANCELLED', 'The request was cancelled.');
}
