import type { ModelRequest, ModelResponse } from './model-types';

export interface ModelRuntime {
  generate(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
      onTextDelta?: (text: string) => void;
    },
  ): Promise<ModelResponse>;
}
