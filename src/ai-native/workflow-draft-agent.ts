import {
  estimateModelInputTokens,
  estimateTextInputTokens,
  modelContextFits,
  normalizeUserQuestion,
  wrapUntrustedPageContent,
} from '../ai/context-builder';
import { decideModelExport } from '../ai/export-policy';
import { MODEL_CATALOG, getModelProfile, type ModelCatalog } from '../ai/model-catalog';
import { ModelError } from '../ai/model-errors';
import { routeModelRequest } from '../ai/model-router';
import type {
  ModelAlias,
  ModelMessage,
  ModelPrivacyRequirement,
  ModelProfile,
  ModelRequest,
} from '../ai/model-types';
import type { WorkflowDraft } from '../shared/ai-native-types';
import type { TabId } from '../shared/browser-types';
import { parseWorkflowDraft, WorkflowDraftValidationError } from './workflow-draft';
import type { WorkflowDraftRuntime } from './workflow-draft-runtime';
import { WORKFLOW_DRAFT_SYSTEM_PROMPT } from './workflow-draft-system-prompt';

const MAX_MODEL_ATTEMPTS = 2;

const FALLBACK_ELIGIBLE_CODES = new Set<ModelError['code']>([
  'MODEL_UNAVAILABLE',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_OUTPUT_INVALID',
]);

export interface WorkflowDraftPageContext {
  readonly tabId: TabId;
  readonly serializedContext: string;
}

export interface WorkflowDraftAgentRequest {
  readonly instruction: string;
  readonly pages: readonly WorkflowDraftPageContext[];
  readonly now: Date;
  readonly defaultTimeZone: string;
  readonly privacy?: ModelPrivacyRequirement;
  readonly abortSignal?: AbortSignal;
}

export interface WorkflowDraftAgentResult {
  readonly draft: WorkflowDraft;
  readonly alias: ModelAlias;
}

export interface WorkflowDraftAgentDependencies {
  runtime: WorkflowDraftRuntime;
  catalog?: ModelCatalog;
}

interface PreparedModelCall {
  profile: ModelProfile;
  messages: ModelMessage[];
  estimatedInputTokens: number;
}

/**
 * WorkflowDraft uses existing taskClass `extraction` → `page-standard`.
 * That alias already advertises structured output; no V8-specific model family.
 */
export class WorkflowDraftAgent {
  private readonly runtime: WorkflowDraftRuntime;
  private readonly catalog: ModelCatalog;

  constructor(dependencies: WorkflowDraftAgentDependencies) {
    this.runtime = dependencies.runtime;
    this.catalog = dependencies.catalog ?? MODEL_CATALOG;
  }

  async generate(request: WorkflowDraftAgentRequest): Promise<WorkflowDraftAgentResult> {
    throwIfCancelled(request.abortSignal);
    const privacy = request.privacy ?? 'remoteAllowed';
    const prepared = this.prepareModelCall({ ...request, privacy });
    const { draft, alias } = await this.generateWithFallback({
      prepared,
      request: { ...request, privacy },
      signal: request.abortSignal ?? new AbortController().signal,
    });
    return { draft, alias };
  }

  private prepareModelCall(input: WorkflowDraftAgentRequest & { privacy: ModelPrivacyRequirement }): PreparedModelCall {
    const probeExport = decideModelExport({
      privacy: input.privacy,
      needsVision: false,
      allowScreenshotExport: false,
      profile: { capabilities: { text: true, vision: false, structuredOutput: true, reasoning: false } },
      hasScreenshot: false,
    });
    if (input.pages.length > 0 && !probeExport.structuredExportAllowed) {
      throw new ModelError('MODEL_NOT_CONFIGURED', 'Remote structured page export is not allowed.');
    }

    const textMessages = buildWorkflowDraftMessages(input);
    let route = routeModelRequest(
      {
        taskClass: 'extraction',
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
          taskClass: 'extraction',
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
    input: WorkflowDraftAgentRequest & { privacy: ModelPrivacyRequirement },
  ): PreparedModelCall {
    const exportDecision = decideModelExport({
      privacy: input.privacy,
      needsVision: false,
      allowScreenshotExport: false,
      profile,
      hasScreenshot: false,
    });
    if (input.pages.length > 0 && !exportDecision.structuredExportAllowed) {
      throw new ModelError('MODEL_NOT_CONFIGURED', 'Remote structured page export is not allowed.');
    }
    const messages = buildWorkflowDraftMessages(input);
    return {
      profile,
      messages,
      estimatedInputTokens: estimateModelInputTokens(messages),
    };
  }

  private async generateWithFallback(input: {
    prepared: PreparedModelCall;
    request: WorkflowDraftAgentRequest & { privacy: ModelPrivacyRequirement };
    signal: AbortSignal;
  }): Promise<{ draft: WorkflowDraft; alias: ModelAlias }> {
    let prepared = input.prepared;
    let lastError: ModelError | undefined;

    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      try {
        throwIfCancelled(input.signal);
        const modelRequest: ModelRequest = {
          requestId: crypto.randomUUID(),
          messages: prepared.messages,
          profile: prepared.profile,
        };
        const response = await this.runtime.generateWorkflowDraft(modelRequest, {
          signal: input.signal,
        });
        const draft = parseWorkflowDraft(response.draft);
        return { draft, alias: prepared.profile.alias };
      } catch (error) {
        lastError = toModelError(error);
        throwIfCancelled(input.signal);
        if (attempt === MAX_MODEL_ATTEMPTS) {
          break;
        }
        const fallback = this.eligibleFallback(lastError, {
          prepared,
          request: input.request,
        });
        if (!fallback) {
          break;
        }
        prepared = fallback;
      }
    }

    throw lastError ?? cancelledError();
  }

  private eligibleFallback(
    error: ModelError,
    input: {
      prepared: PreparedModelCall;
      request: WorkflowDraftAgentRequest & { privacy: ModelPrivacyRequirement };
    },
  ): PreparedModelCall | undefined {
    if (!FALLBACK_ELIGIBLE_CODES.has(error.code)) {
      return undefined;
    }
    const fallbackAlias = input.prepared.profile.fallbackAlias;
    if (fallbackAlias === undefined) {
      return undefined;
    }
    const fallbackProfile = getModelProfile(fallbackAlias, this.catalog);
    const rebuilt = this.buildFinalCall(fallbackProfile, input.request);
    if (!modelContextFits(fallbackProfile, rebuilt.estimatedInputTokens)) {
      return undefined;
    }
    return rebuilt;
  }
}

export function buildWorkflowDraftMessages(input: {
  instruction: string;
  pages: readonly WorkflowDraftPageContext[];
  now: Date;
  defaultTimeZone: string;
}): ModelMessage[] {
  const instruction = normalizeUserQuestion(input.instruction);
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: [{ type: 'text', text: WORKFLOW_DRAFT_SYSTEM_PROMPT }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            'TRUSTED_DRAFT_CONTEXT',
            `currentUtc=${input.now.toISOString()}`,
            `defaultTimeZone=${input.defaultTimeZone}`,
          ].join('\n'),
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: `USER_INSTRUCTION\n${instruction}` }],
    },
  ];

  for (const page of input.pages) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `UNTRUSTED_PAGE_CONTEXT tab ${page.tabId}\n${wrapUntrustedPageContent(page.serializedContext)}`,
        },
      ],
    });
  }

  return messages;
}

function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) {
    return error;
  }
  if (error instanceof WorkflowDraftValidationError) {
    return new ModelError('MODEL_OUTPUT_INVALID', 'The model output was invalid.', { cause: error });
  }
  return new ModelError('MODEL_REQUEST_FAILED', 'The model request failed.', { cause: error });
}

function cancelledError(): ModelError {
  return new ModelError('REQUEST_CANCELLED', 'The request was cancelled.');
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw cancelledError();
  }
}
