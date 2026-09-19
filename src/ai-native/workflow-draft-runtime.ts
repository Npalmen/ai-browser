import type { ModelCost, ModelRequest, ModelUsage } from '../ai/model-types';
import type { WorkflowDraft } from '../shared/ai-native-types';

export interface WorkflowDraftRuntimeResponse {
  readonly draft: WorkflowDraft;
  readonly usage?: ModelUsage;
  readonly cost?: ModelCost;
  readonly resolvedProviderModelId: string;
  readonly latencyMs: number;
}

export interface WorkflowDraftRuntime {
  generateWorkflowDraft(
    request: ModelRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowDraftRuntimeResponse>;
}
