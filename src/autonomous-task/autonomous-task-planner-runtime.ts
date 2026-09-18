import type { AutonomousTaskDecision } from './autonomous-task-decision';
import type { ModelCost, ModelRequest, ModelUsage } from '../ai/model-types';

export interface AutonomousTaskPlannerResponse {
  readonly decision: AutonomousTaskDecision;
  readonly usage?: ModelUsage;
  readonly cost?: ModelCost;
  readonly resolvedProviderModelId: string;
  readonly latencyMs: number;
}

export interface AutonomousTaskPlannerRuntime {
  generateAutonomousTaskDecision(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<AutonomousTaskPlannerResponse>;
}
