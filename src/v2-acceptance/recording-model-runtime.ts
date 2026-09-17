import { ModelError } from '../ai/model-errors';
import type { ModelRuntime } from '../ai/model-runtime';
import type { ModelRequest, ModelResponse } from '../ai/model-types';
import type { TargetId } from '../shared/observation-types';

export class RecordingModelRuntime implements ModelRuntime {
  readonly requests: ModelRequest[] = [];
  abortReachedRuntime = false;

  constructor(
    private readonly script: {
      deltas: readonly string[];
      text: string;
      extraReferencedTargets?: TargetId[];
      pickExportedTarget?: boolean;
    },
  ) {}

  async generate(
    request: ModelRequest,
    options?: {
      signal?: AbortSignal;
      onTextDelta?: (text: string) => void;
    },
  ): Promise<ModelResponse> {
    this.requests.push(request);
    if (options?.signal?.aborted) {
      this.abortReachedRuntime = true;
      throw new ModelError('REQUEST_CANCELLED', 'Recording runtime aborted before generate.');
    }

    for (const delta of this.script.deltas) {
      if (options?.signal?.aborted) {
        this.abortReachedRuntime = true;
        throw new ModelError('REQUEST_CANCELLED', 'Recording runtime aborted during deltas.');
      }
      options?.onTextDelta?.(delta);
    }

    const referencedTargets: TargetId[] = [];
    if (this.script.pickExportedTarget) {
      const exported = firstExportedTargetId(request);
      if (exported) {
        referencedTargets.push(exported);
      }
    }
    if (this.script.extraReferencedTargets) {
      referencedTargets.push(...this.script.extraReferencedTargets);
    }

    return {
      text: this.script.text,
      referencedTargets,
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }
}

function firstExportedTargetId(request: ModelRequest): string | undefined {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type !== 'text') {
        continue;
      }
      const match = part.text.match(/"targetId":"([^"]+)"/);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return undefined;
}
