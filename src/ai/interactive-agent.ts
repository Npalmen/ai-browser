import { ConversationStore } from './conversation-store';
import { InteractiveStepAgent } from './interactive-step-agent';
import type { InteractionModelRuntime } from './interaction-model-runtime';
import type {
  InteractionExecutionPort,
  InteractiveExecutionResult,
} from './interaction-execution-port';
import { MODEL_CATALOG, type ModelCatalog } from './model-catalog';
import { ModelError } from './model-errors';
import type { ModelAlias, ModelPrivacyRequirement, TaskClass } from './model-types';
import type { PageObservationSource } from './read-only-agent';
import type { TabId } from '../shared/browser-types';
import type { InteractionResult } from '../shared/interaction-types';
import type { TargetId } from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';

export type {
  ApprovalRequiredExecutionResult,
  InteractionExecutionPort,
  InteractiveExecutionResult,
} from './interaction-execution-port';

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
      result: InteractiveExecutionResult;
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
  private readonly interactionExecutor: InteractionExecutionPort;
  private readonly conversations: ConversationStore;
  private readonly stepAgent: InteractiveStepAgent;
  private readonly latestGeneration = new Map<TabId, number>();
  private readonly controllers = new Map<TabId, AbortController>();
  private readonly tails = new Map<TabId, Promise<void>>();

  constructor(dependencies: InteractiveAgentDependencies) {
    this.interactionExecutor = dependencies.interactionExecutor;
    this.conversations = new ConversationStore();
    this.stepAgent = new InteractiveStepAgent({
      observationSource: dependencies.observationSource,
      modelRuntime: dependencies.modelRuntime,
      catalog: dependencies.catalog ?? MODEL_CATALOG,
      allowScreenshotExport: dependencies.allowScreenshotExport,
    });
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

    let step;
    try {
      step = await this.stepAgent.step(
        {
          tabId: input.tabId,
          instruction: input.instruction,
          taskClass: input.taskClass,
          needsVision: input.needsVision,
          privacy: input.privacy,
        },
        {
          signal: input.signal,
          onAnswerTextDelta: (text) => {
            if (this.latestGeneration.get(input.tabId) !== input.generation || input.signal.aborted) {
              return;
            }
            input.onAnswerTextDelta?.(text);
          },
          priorConversationForRevision: (tabId, revision) =>
            this.conversations.serializeForRevision(tabId, revision),
        },
      );
    } catch (error) {
      if (error instanceof ObservationError && error.code === 'TAB_NOT_FOUND') {
        this.conversations.clear(input.tabId);
      }
      throw error;
    }

    throwIfCancelled(input.signal);
    if (this.latestGeneration.get(input.tabId) !== input.generation) {
      throw cancelledError();
    }

    if (step.kind === 'answer') {
      this.conversations.commitTurn(input.tabId, step.observation.document.revision, {
        question: input.instruction,
        answer: step.text,
      });
      return {
        kind: 'answer',
        text: step.text,
        referencedTargets: [...step.referencedTargets],
        alias: step.alias,
        truncatedContext: step.truncatedContext,
      };
    }

    throwIfCancelled(input.signal);
    const result = await this.interactionExecutor.execute({
      proposal: step.proposal,
      observation: step.observation,
      signal: input.signal,
    });

    if (result.status !== 'approval-required') {
      this.conversations.commitTurn(input.tabId, step.observation.document.revision, {
        question: input.instruction,
        answer: summarizeInteractionResult(step.proposal.kind, result),
      });
    }

    return {
      kind: 'interaction',
      result,
      alias: step.alias,
      truncatedContext: step.truncatedContext,
    };
  }
}

function summarizeInteractionResult(proposalKind: string, result: InteractionResult): string {
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
