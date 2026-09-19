import { ModelError } from '../ai/model-errors';
import { AutonomousTaskError } from './autonomous-task-errors';
import type { AutonomousTaskPlannerInput } from './autonomous-task-planner-context';
import type { AutonomousTaskPlanner, AutonomousTaskPlannerResult } from './autonomous-task-planner';
import type { AutonomousTaskId, AutonomousTaskRef } from './autonomous-task-types';

interface ActivePlanner {
  readonly ref: AutonomousTaskRef;
  readonly controller: AbortController;
  readonly completion: Promise<AutonomousTaskPlannerResult>;
}

export interface AutonomousTaskPlannerExecutorDependencies {
  planner: Pick<AutonomousTaskPlanner, 'plan'>;
}

/**
 * Owns exact-ref planner cancellation. Does not apply task state transitions.
 */
export class AutonomousTaskPlannerExecutor {
  private readonly planner: Pick<AutonomousTaskPlanner, 'plan'>;
  private readonly activeByTask = new Map<AutonomousTaskId, ActivePlanner>();

  constructor(deps: AutonomousTaskPlannerExecutorDependencies) {
    this.planner = deps.planner;
  }

  async plan(
    ref: AutonomousTaskRef,
    input: AutonomousTaskPlannerInput = {},
  ): Promise<AutonomousTaskPlannerResult> {
    if (this.activeByTask.has(ref.taskId)) {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${ref.taskId} already has an active planner generation.`,
      );
    }
    const controller = new AbortController();
    const completion = this.planner
      .plan(ref, input, { signal: controller.signal })
      .then((result) => result, (error: unknown) => {
        if (isCancelledError(error)) {
          return { status: 'ignored' as const };
        }
        throw error;
      })
      .finally(() => {
        const current = this.activeByTask.get(ref.taskId);
        if (current !== undefined && current.ref.generation === ref.generation) {
          this.activeByTask.delete(ref.taskId);
        }
      });
    this.activeByTask.set(ref.taskId, { ref, controller, completion });
    return completion;
  }

  cancel(ref: AutonomousTaskRef): boolean {
    const active = this.activeByTask.get(ref.taskId);
    if (active === undefined || active.ref.generation !== ref.generation) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  async cancelAndWait(ref: AutonomousTaskRef): Promise<void> {
    const active = this.activeByTask.get(ref.taskId);
    if (active === undefined || active.ref.generation !== ref.generation) {
      return;
    }
    this.cancel(ref);
    await active.completion;
  }

  hasActive(taskId: AutonomousTaskId): boolean {
    return this.activeByTask.has(taskId);
  }
}

function isCancelledError(error: unknown): boolean {
  return error instanceof ModelError && error.code === 'REQUEST_CANCELLED';
}
