import { ModelError } from '../ai/model-errors';
import type { InteractionModelRuntime } from '../ai/interaction-model-runtime';
import type { AgentModelOutput } from '../ai/interaction-output-schema';
import type { ModelRuntime } from '../ai/model-runtime';
import type { ModelRequest, ModelResponse } from '../ai/model-types';
import type { WorkflowDraft } from '../shared/ai-native-types';
import type { AutonomousTaskDecision } from '../autonomous-task/autonomous-task-decision';
import type { AutonomousTaskPlannerRuntime } from '../autonomous-task/autonomous-task-planner-runtime';
import type {
  WorkflowDraftRuntime,
  WorkflowDraftRuntimeResponse,
} from '../ai-native/workflow-draft-runtime';
import type { InteractiveModelPageContext } from '../ai/interaction-context-builder';
import { parseInteractiveContextFromMessages } from '../v3-acceptance/context-helpers';

export type V8AskScript = (request: ModelRequest) => string;
export type V8InteractionScript = (
  context: InteractiveModelPageContext,
  instruction: string,
) => AgentModelOutput;
export type V8DraftScript = (request: ModelRequest) => unknown;
export type V8PlannerScript = (request: ModelRequest) => AutonomousTaskDecision;

export class V8AcceptanceRuntime
  implements ModelRuntime, InteractionModelRuntime, AutonomousTaskPlannerRuntime, WorkflowDraftRuntime
{
  readonly generateRequests: ModelRequest[] = [];
  readonly interactionRequests: ModelRequest[] = [];
  readonly draftRequests: ModelRequest[] = [];
  readonly plannerRequests: ModelRequest[] = [];

  askScript: V8AskScript = () => 'The heading is V8 verdite heading.';
  interactionScript: V8InteractionScript = () => ({
    kind: 'answer',
    text: 'No interaction.',
    referencedTargets: [],
  });
  draftScript: V8DraftScript = () => ({
    name: 'Status check',
    objective: 'Check the status page for outages.',
    entryPoint: { kind: 'url', url: 'https://example.test/status' },
    trigger: { kind: 'manual' },
  });
  plannerScript: V8PlannerScript = () => ({
    kind: 'complete',
    answer: 'Delegate finished.',
  });

  get generateCount(): number {
    return this.generateRequests.length;
  }

  get interactionCount(): number {
    return this.interactionRequests.length;
  }

  get draftCount(): number {
    return this.draftRequests.length;
  }

  get plannerCount(): number {
    return this.plannerRequests.length;
  }

  resetCounts(): void {
    this.generateRequests.length = 0;
    this.interactionRequests.length = 0;
    this.draftRequests.length = 0;
    this.plannerRequests.length = 0;
  }

  async generate(
    request: ModelRequest,
    options?: { signal?: AbortSignal; onTextDelta?: (text: string) => void },
  ): Promise<ModelResponse> {
    this.generateRequests.push(request);
    throwIfAborted(options?.signal);
    const text = this.askScript(request);
    options?.onTextDelta?.(text);
    return {
      text,
      referencedTargets: [],
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }

  async generateInteraction(
    request: ModelRequest,
    options?: { signal?: AbortSignal; onAnswerTextDelta?: (text: string) => void },
  ) {
    this.interactionRequests.push(request);
    throwIfAborted(options?.signal);
    const context = parseInteractiveContextFromMessages(request.messages);
    const instruction = lastUserInstruction(request);
    const output = this.interactionScript(context, instruction);
    if (output.kind === 'answer') {
      options?.onAnswerTextDelta?.(output.text);
    }
    return {
      output,
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }

  async generateWorkflowDraft(
    request: ModelRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowDraftRuntimeResponse> {
    this.draftRequests.push(request);
    throwIfAborted(options?.signal);
    return {
      draft: this.draftScript(request) as WorkflowDraft,
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }

  async generateAutonomousTaskDecision(request: ModelRequest, options?: { signal?: AbortSignal }) {
    this.plannerRequests.push(request);
    throwIfAborted(options?.signal);
    return {
      decision: this.plannerScript(request),
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }
}

function lastUserInstruction(request: ModelRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== 'user') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text' && !part.text.includes('<UNTRUSTED_PAGE_CONTENT>')) {
        return part.text;
      }
    }
  }
  return '';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ModelError('REQUEST_CANCELLED', 'V8 recording runtime aborted.');
  }
}
