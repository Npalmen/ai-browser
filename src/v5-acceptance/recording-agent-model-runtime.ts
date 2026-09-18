import type { InteractiveModelPageContext } from '../ai/interaction-context-builder';
import type { InteractionModelRuntime } from '../ai/interaction-model-runtime';
import type { AgentModelOutput } from '../ai/interaction-output-schema';
import { ModelError } from '../ai/model-errors';
import type { ModelMessage, ModelRequest, ModelResponse } from '../ai/model-types';
import { RecordingInteractionModelRuntime } from '../v3-acceptance/recording-interaction-model-runtime';
import { parseInteractiveContextFromMessages } from '../v3-acceptance/context-helpers';

export type V5InteractionRecordingScript = (
  context: InteractiveModelPageContext,
  instruction: string,
) => AgentModelOutput | Promise<AgentModelOutput>;

function extractInstruction(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
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

export class V5AcceptanceModelRuntime
  extends RecordingInteractionModelRuntime
  implements InteractionModelRuntime
{
  constructor(
    private readonly deferredScript: V5InteractionRecordingScript,
    private readonly askAnswer = 'read answer',
  ) {
    super(() => ({
      kind: 'answer',
      text: 'unused',
      referencedTargets: [],
    }));
  }

  override async generateInteraction(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
      onAnswerTextDelta?: (text: string) => void;
    },
  ) {
    this.requests.push(request);
    if (options?.signal?.aborted) {
      throw new ModelError('REQUEST_CANCELLED', 'Recording interaction runtime aborted.');
    }

    const context = parseInteractiveContextFromMessages(request.messages);
    const instruction = extractInstruction(request.messages);
    const output = await this.deferredScript(context, instruction);
    if (output.kind === 'answer') {
      options?.onAnswerTextDelta?.(output.text);
    }

    return {
      output,
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }

  async generate(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
      onTextDelta?: (text: string) => void;
    },
  ): Promise<ModelResponse> {
    this.requests.push(request);
    if (options?.signal?.aborted) {
      throw new ModelError('REQUEST_CANCELLED', 'Recording runtime aborted.');
    }
    options?.onTextDelta?.(this.askAnswer);
    return {
      text: this.askAnswer,
      referencedTargets: [],
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }
}
