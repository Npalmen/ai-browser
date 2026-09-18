import type { InteractionModelRuntime } from '../ai/interaction-model-runtime';
import type { AgentModelOutput } from '../ai/interaction-output-schema';
import { ModelError } from '../ai/model-errors';
import type { ModelRequest } from '../ai/model-types';
import type { InteractiveModelPageContext } from '../ai/interaction-context-builder';
import { parseInteractiveContextFromMessages } from './context-helpers';

function extractUserQuestion(messages: ModelRequest['messages']): string {
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

export type InteractionRecordingScript = (
  context: InteractiveModelPageContext,
  instruction: string,
) => AgentModelOutput;

export class RecordingInteractionModelRuntime implements InteractionModelRuntime {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: InteractionRecordingScript) {}

  async generateInteraction(
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
    const instruction = extractUserQuestion(request.messages);
    const output = this.script(context, instruction);
    if (output.kind === 'answer') {
      options?.onAnswerTextDelta?.(output.text);
    }

    return {
      output,
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }
}
