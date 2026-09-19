import { ModelError } from '../ai/model-errors';
import type { ModelRequest } from '../ai/model-types';
import type { AutonomousTaskDecision } from '../autonomous-task/autonomous-task-decision';
import type { AutonomousTaskPlannerRuntime } from '../autonomous-task/autonomous-task-planner-runtime';

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export type PlannerRecordingScript = (
  request: ModelRequest,
  callIndex: number,
) => unknown | Promise<unknown>;

export class RecordingPlannerRuntime implements AutonomousTaskPlannerRuntime {
  readonly requests: ModelRequest[] = [];
  hold: Deferred<unknown> | undefined;
  decisions: unknown[] = [];
  script: PlannerRecordingScript | undefined;

  constructor(script?: PlannerRecordingScript | readonly unknown[]) {
    if (typeof script === 'function') {
      this.script = script;
    } else if (script !== undefined) {
      this.decisions = [...script];
    }
  }

  async generateAutonomousTaskDecision(
    request: ModelRequest,
    options?: { signal?: AbortSignal },
  ) {
    this.requests.push(request);
    if (options?.signal?.aborted) {
      throw new ModelError('REQUEST_CANCELLED', 'Recording planner runtime aborted.');
    }

    const decision = await this.nextDecision(request, options?.signal);
    if (options?.signal?.aborted) {
      throw new ModelError('REQUEST_CANCELLED', 'Recording planner runtime aborted.');
    }

    return {
      decision: decision as AutonomousTaskDecision,
      resolvedProviderModelId: request.profile.providerModelId,
      latencyMs: 1,
    };
  }

  private async nextDecision(request: ModelRequest, signal?: AbortSignal): Promise<unknown> {
    if (this.hold !== undefined) {
      const held = this.hold;
      return await new Promise<unknown>((resolve, reject) => {
        const onAbort = () => {
          reject(new ModelError('REQUEST_CANCELLED', 'Recording planner runtime aborted.'));
        };
        signal?.addEventListener('abort', onAbort);
        void held.promise.then(
          (value) => {
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
              reject(new ModelError('REQUEST_CANCELLED', 'Recording planner runtime aborted.'));
              return;
            }
            resolve(value);
          },
          (error: unknown) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    }
    if (this.script !== undefined) {
      return await this.script(request, this.requests.length);
    }
    const decision = this.decisions.shift();
    if (decision === undefined) {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'No scripted planner decision.');
    }
    return decision;
  }
}
