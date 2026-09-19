import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from '../ai/model-errors';
import { AutonomousTaskCoordinator } from './autonomous-task-coordinator';
import { AutonomousTaskPlannerExecutor } from './autonomous-task-planner-executor';
import type { AutonomousTaskPlannerResult } from './autonomous-task-planner';
import { toAutonomousTaskRef } from './autonomous-task-types';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

describe('AutonomousTaskPlannerExecutor', () => {
  it('cancels the exact planner generation and ignores the late result', async () => {
    const coordinator = new AutonomousTaskCoordinator({ generateTaskId: () => 'task-1' });
    const task = coordinator.startTask('tab-a', 'Book the cheapest refundable flight');
    const hold = new Deferred<AutonomousTaskPlannerResult>();
    const planner = {
      async plan(
        _ref: ReturnType<typeof toAutonomousTaskRef>,
        _input: unknown,
        options: { signal?: AbortSignal } = {},
      ): Promise<AutonomousTaskPlannerResult> {
        if (options.signal?.aborted) {
          throw new ModelError('REQUEST_CANCELLED', 'cancelled');
        }
        await new Promise<void>((resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new ModelError('REQUEST_CANCELLED', 'cancelled'));
          });
          void hold.promise.then(() => resolve());
        });
        return { status: 'ignored' };
      },
    };
    const executor = new AutonomousTaskPlannerExecutor({ planner });
    const pending = executor.plan(toAutonomousTaskRef(task));
    assert.equal(executor.hasActive(task.taskId), true);
    await executor.cancelAndWait(toAutonomousTaskRef(task));
    const result = await pending;
    assert.equal(result.status, 'ignored');
    assert.equal(executor.hasActive(task.taskId), false);
    hold.resolve({ status: 'ignored' });
  });

  it('does not cancel a newer generation using a stale ref', async () => {
    const coordinator = new AutonomousTaskCoordinator({ generateTaskId: () => 'task-1' });
    const task = coordinator.startTask('tab-a', 'Book the cheapest refundable flight');
    const firstRef = toAutonomousTaskRef(task);
    coordinator.pauseAtSafeBoundary(firstRef);
    coordinator.resumeTask(firstRef);
    const hold = new Deferred<AutonomousTaskPlannerResult>();
    const planner = {
      async plan(): Promise<AutonomousTaskPlannerResult> {
        return hold.promise;
      },
    };
    const executor = new AutonomousTaskPlannerExecutor({ planner });
    const current = coordinator.getTask(task.taskId)!;
    const pending = executor.plan(toAutonomousTaskRef(current));
    assert.equal(executor.cancel(firstRef), false);
    assert.equal(executor.hasActive(task.taskId), true);
    hold.resolve({ status: 'ignored' });
    await pending;
  });
});
