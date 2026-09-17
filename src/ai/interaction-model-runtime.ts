import type { AgentModelOutput } from './interaction-output-schema';
import type { ModelCost, ModelRequest, ModelUsage } from './model-types';

export interface InteractionModelResponse {
  output: AgentModelOutput;
  usage?: ModelUsage;
  cost?: ModelCost;
  resolvedProviderModelId: string;
  latencyMs: number;
}

export interface InteractionModelRuntime {
  generateInteraction(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
      onAnswerTextDelta?: (text: string) => void;
    },
  ): Promise<InteractionModelResponse>;
}
