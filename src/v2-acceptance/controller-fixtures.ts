import type { AiInteractionAgent, AiReadAgent } from '../main/ai-request-controller';
import { AiRequestController } from '../main/ai-request-controller';
import type { AiAnswerEvent } from '../shared/ai-types';

export function noopInteractionAgent(): AiInteractionAgent {
  return {
    interact: async () => {
      throw new Error('interactive agent not expected');
    },
    cancel: () => false,
    clearConversation: () => {},
    clearAllConversations: () => {},
  };
}

export function readOnlyController(
  readAgent: AiReadAgent,
  emit: (event: AiAnswerEvent) => void,
): AiRequestController {
  return new AiRequestController({
    readAgent,
    interactiveAgent: noopInteractionAgent(),
    emit,
  });
}
