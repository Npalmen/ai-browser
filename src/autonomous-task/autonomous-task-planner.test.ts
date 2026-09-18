import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ModelCatalog, ModelCatalogEntry } from '../ai/model-catalog';
import { MODEL_CATALOG } from '../ai/model-catalog';
import { ModelError, type ModelErrorCode } from '../ai/model-errors';
import type { ModelRequest } from '../ai/model-types';
import { InMemoryAutonomousTaskAuditSink } from './autonomous-task-audit';
import { AutonomousTaskCoordinator } from './autonomous-task-coordinator';
import type { AutonomousTaskDecision } from './autonomous-task-decision';
import type { AutonomousTaskPlannerRuntime } from './autonomous-task-planner-runtime';
import type { AutonomousTaskPlannerContextInput } from './autonomous-task-planner-context';
import {
  AutonomousTaskPlanner,
  MAX_AUTONOMOUS_TASK_MODEL_ATTEMPTS,
} from './autonomous-task-planner';
import {
  MAX_AUTONOMOUS_TASK_PLANNER_STEPS,
  toAutonomousTaskRef,
  type AutonomousTaskMutationResult,
  type AutonomousTaskRef,
  type AutonomousTaskSnapshot,
} from './autonomous-task-types';

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakePlannerRuntime implements AutonomousTaskPlannerRuntime {
  readonly requests: ModelRequest[] = [];
  impl: (
    request: ModelRequest,
    options: { signal?: AbortSignal } | undefined,
    callIndex: number,
  ) => Promise<{
    decision: AutonomousTaskDecision;
    resolvedProviderModelId: string;
    latencyMs: number;
  }>;

  constructor(impl?: FakePlannerRuntime['impl'] | AutonomousTaskDecision) {
    if (typeof impl === 'function') {
      this.impl = impl;
    } else {
      const decision =
        impl ??
        ({
          kind: 'delegate-subgoal',
          taskTabAlias: 'task-tab-1',
          instruction: 'Compare prices',
        } satisfies AutonomousTaskDecision);
      this.impl = async () => ({
        decision,
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      });
    }
  }

  async generateAutonomousTaskDecision(
    request: ModelRequest,
    options?: { signal?: AbortSignal },
  ) {
    this.requests.push(request);
    const result = await this.impl(request, options, this.requests.length);
    return {
      decision: result.decision,
      resolvedProviderModelId: result.resolvedProviderModelId,
      latencyMs: result.latencyMs,
    };
  }
}

interface Harness {
  coordinator: AutonomousTaskCoordinator;
  sink: InMemoryAutonomousTaskAuditSink;
  now: number;
  setNow(value: number): void;
}

function createHarness(startNow = 1_000): Harness {
  const harness: Harness = {
    now: startNow,
    sink: new InMemoryAutonomousTaskAuditSink(),
    coordinator: undefined as unknown as AutonomousTaskCoordinator,
    setNow(value: number) {
      harness.now = value;
    },
  };
  harness.coordinator = new AutonomousTaskCoordinator({
    now: () => harness.now,
    auditSink: harness.sink,
  });
  return harness;
}

function start(
  harness: Harness,
  tabId = 'tab-1',
  objective = 'compare these three plans',
): AutonomousTaskSnapshot {
  return harness.coordinator.startTask(tabId, objective);
}

function refOf(snapshot: AutonomousTaskSnapshot): AutonomousTaskRef {
  return toAutonomousTaskRef(snapshot);
}

function requireApplied(result: AutonomousTaskMutationResult): AutonomousTaskSnapshot {
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') {
    throw new Error('expected applied mutation');
  }
  return result.snapshot;
}

function plannerContext(
  harness: Harness,
  snapshot: AutonomousTaskSnapshot,
  overrides: Partial<AutonomousTaskPlannerContextInput> = {},
): AutonomousTaskPlannerContextInput {
  return {
    snapshot,
    ownedTabs: harness.coordinator.getOwnedTabs(snapshot.taskId).map((tab) => ({
      alias: tab.alias,
      ownershipKind: tab.ownershipKind,
    })),
    ...overrides,
  };
}

function plannerOf(input: {
  harness?: Harness;
  runtime?: FakePlannerRuntime;
  catalog?: ModelCatalog;
}) {
  const harness = input.harness ?? createHarness();
  const runtime = input.runtime ?? new FakePlannerRuntime();
  const planner = new AutonomousTaskPlanner({
    coordinator: harness.coordinator,
    runtime,
    catalog: input.catalog,
  });
  return { planner, harness, runtime };
}

function testCatalogEntry(
  alias: keyof typeof MODEL_CATALOG,
  overrides: Partial<ModelCatalogEntry['profile']> = {},
): ModelCatalogEntry {
  const base = MODEL_CATALOG[alias];
  return {
    gateway: base.gateway,
    profile: {
      ...base.profile,
      ...overrides,
      alias,
      capabilities: {
        ...base.profile.capabilities,
        ...overrides.capabilities,
      },
    },
  };
}

function fallbackCatalog(): ModelCatalog {
  return {
    'page-fast': testCatalogEntry('page-fast'),
    'page-standard': testCatalogEntry('page-standard'),
    'page-deep': testCatalogEntry('page-deep', { fallbackAlias: 'page-standard' }),
    'page-vision': testCatalogEntry('page-vision'),
  };
}

function isModelError(code: ModelErrorCode) {
  return (error: unknown) => error instanceof ModelError && error.code === code;
}

describe('AutonomousTaskPlanner decisions', () => {
  it('returns a validated delegate decision for an owned alias', async () => {
    const { planner, harness, runtime } = plannerOf({});
    const task = start(harness);
    const result = await planner.plan(refOf(task), plannerContext(harness, task));

    assert.equal(result.status, 'decision');
    if (result.status === 'decision') {
      assert.equal(result.decision.kind, 'delegate-subgoal');
      assert.equal(result.decision.taskTabAlias, 'task-tab-1');
      assert.equal(result.alias, 'page-deep');
    }
    assert.equal(runtime.requests.length, 1);
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 1);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'planning');
    assert.equal(harness.coordinator.getTask(task.taskId)?.childRunCount, 0);
  });

  it('rejects unknown task tab aliases as MODEL_OUTPUT_INVALID without counting a planner step', async () => {
    const runtime = new FakePlannerRuntime({
      kind: 'delegate-subgoal',
      taskTabAlias: 'task-tab-99',
      instruction: 'Continue',
    });
    const { planner, harness } = plannerOf({ runtime });
    const task = start(harness);

    await assert.rejects(
      () => planner.plan(refOf(task), plannerContext(harness, task)),
      isModelError('MODEL_OUTPUT_INVALID'),
    );
    assert.equal(runtime.requests.length, 1);
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 0);
  });

  it('accepts only aliases owned by the current task', async () => {
    const harness = createHarness();
    const first = start(harness, 'tab-a');
    requireApplied(harness.coordinator.adoptTaskTab(refOf(first), 'tab-b', 'task-created'));
    requireApplied(harness.coordinator.pauseAtSafeBoundary(refOf(first)));
    const second = start(harness, 'tab-c');
    const runtime = new FakePlannerRuntime({
      kind: 'delegate-subgoal',
      taskTabAlias: 'task-tab-1',
      instruction: 'Use the first tab',
    });
    const planner = new AutonomousTaskPlanner({
      coordinator: harness.coordinator,
      runtime,
    });

    const result = await planner.plan(refOf(second), plannerContext(harness, second));
    assert.equal(result.status, 'decision');
    assert.equal(harness.coordinator.resolveTaskTabAlias(first.taskId, 'task-tab-1')?.tabId, 'tab-a');
    assert.equal(harness.coordinator.resolveTaskTabAlias(second.taskId, 'task-tab-1')?.tabId, 'tab-c');
  });
});

describe('AutonomousTaskPlanner fallback and budget', () => {
  it('treats provider fallback as one logical planner step', async () => {
    const runtime = new FakePlannerRuntime(async (_request, _options, callIndex) => {
      if (callIndex === 1) {
        throw new ModelError('MODEL_UNAVAILABLE', 'unavailable');
      }
      return {
        decision: {
          kind: 'complete',
          answer: 'Finished after fallback.',
        },
        resolvedProviderModelId: 'test/fallback',
        latencyMs: 1,
      };
    });
    const { planner, harness } = plannerOf({ runtime, catalog: fallbackCatalog() });
    const task = start(harness);

    const result = await planner.plan(refOf(task), plannerContext(harness, task));
    assert.equal(result.status, 'decision');
    if (result.status === 'decision') {
      assert.equal(result.decision.kind, 'complete');
    }
    assert.equal(runtime.requests.length, MAX_AUTONOMOUS_TASK_MODEL_ATTEMPTS);
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 1);
  });

  it('propagates ModelError when both fallback attempts fail without counting a planner step', async () => {
    const runtime = new FakePlannerRuntime(async () => {
      throw new ModelError('MODEL_UNAVAILABLE', 'still unavailable');
    });
    const { planner, harness } = plannerOf({ runtime, catalog: fallbackCatalog() });
    const task = start(harness);

    await assert.rejects(
      () => planner.plan(refOf(task), plannerContext(harness, task)),
      isModelError('MODEL_UNAVAILABLE'),
    );
    assert.equal(runtime.requests.length, MAX_AUTONOMOUS_TASK_MODEL_ATTEMPTS);
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 0);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'planning');
  });

  it('returns the eighth valid decision while keeping the task in planning', async () => {
    const { planner, harness, runtime } = plannerOf({});
    const task = start(harness);
    let current = refOf(task);
    for (let step = 0; step < MAX_AUTONOMOUS_TASK_PLANNER_STEPS - 1; step += 1) {
      requireApplied(harness.coordinator.recordPlannerStepCompleted(current));
      current = refOf(harness.coordinator.getTask(task.taskId)!);
    }
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 7);

    const snapshot = harness.coordinator.getTask(task.taskId)!;
    const result = await planner.plan(current, plannerContext(harness, snapshot));
    assert.equal(result.status, 'decision');
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 8);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'planning');
    assert.equal(runtime.requests.length, 1);
  });

  it('fails before runtime when planner budget is already exhausted', async () => {
    const runtime = new FakePlannerRuntime();
    const { planner, harness } = plannerOf({ runtime });
    const task = start(harness);
    let current = refOf(task);
    for (let step = 0; step < MAX_AUTONOMOUS_TASK_PLANNER_STEPS; step += 1) {
      requireApplied(harness.coordinator.recordPlannerStepCompleted(current));
      current = refOf(harness.coordinator.getTask(task.taskId)!);
    }
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 8);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'planning');

    const snapshot = harness.coordinator.getTask(task.taskId)!;
    await assert.rejects(
      () => planner.plan(current, plannerContext(harness, snapshot)),
      isModelError('MODEL_REQUEST_FAILED'),
    );
    assert.equal(runtime.requests.length, 0);
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 8);
  });
});

describe('AutonomousTaskPlanner cancellation and stale generation', () => {
  it('cancels during generation without accepting a decision or counting a planner step', async () => {
    const modelStarted = new Deferred<void>();
    const releaseModel = new Deferred<void>();
    const runtime = new FakePlannerRuntime(async (_request, options) => {
      modelStarted.resolve();
      await releaseModel.promise;
      if (options?.signal?.aborted) {
        throw new ModelError('REQUEST_CANCELLED', 'cancelled');
      }
      return {
        decision: { kind: 'complete' as const, answer: 'Too late' },
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      };
    });
    const { planner, harness } = plannerOf({ runtime });
    const task = start(harness);
    const controller = new AbortController();
    const pending = planner.plan(refOf(task), plannerContext(harness, task), {
      signal: controller.signal,
    });
    await modelStarted.promise;
    controller.abort();
    releaseModel.resolve();

    await assert.rejects(pending, isModelError('REQUEST_CANCELLED'));
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 0);
  });

  it('rejects a late valid provider result after the signal is aborted', async () => {
    const runtime = new FakePlannerRuntime(async () => ({
      decision: { kind: 'complete' as const, answer: 'Late answer' },
      resolvedProviderModelId: 'test/model',
      latencyMs: 1,
    }));
    const { planner, harness } = plannerOf({ runtime });
    const task = start(harness);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        planner.plan(refOf(task), plannerContext(harness, task), {
          signal: controller.signal,
        }),
      isModelError('REQUEST_CANCELLED'),
    );
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 0);
  });

  it('ignores a late planner result from a superseded generation', async () => {
    const modelStarted = new Deferred<void>();
    const releaseModel = new Deferred<void>();
    const runtime = new FakePlannerRuntime(async () => {
      modelStarted.resolve();
      await releaseModel.promise;
      return {
        decision: {
          kind: 'delegate-subgoal' as const,
          taskTabAlias: 'task-tab-1',
          instruction: 'Stale generation work',
        },
        resolvedProviderModelId: 'test/model',
        latencyMs: 1,
      };
    });
    const { planner, harness } = plannerOf({ runtime });
    const task = start(harness);
    const gen1 = refOf(task);
    const pending = planner.plan(gen1, plannerContext(harness, task));
    await modelStarted.promise;
    const resumed = requireApplied(harness.coordinator.pauseAtSafeBoundary(gen1));
    requireApplied(harness.coordinator.resumeTask(refOf(resumed)));
    releaseModel.resolve();

    const result = await pending;
    assert.deepEqual(result, { status: 'ignored' });
    assert.equal(harness.coordinator.getTask(task.taskId)?.generation, 2);
    assert.equal(harness.coordinator.getTask(task.taskId)?.plannerStepCount, 0);
    assert.equal(harness.coordinator.getTask(task.taskId)?.state, 'planning');
  });
});

describe('AutonomousTaskPlanner source isolation', () => {
  it('does not import browser adapters, agent-run, approval, Electron, React, or IPC', () => {
    const files = [
      'autonomous-task-planner.ts',
      'autonomous-task-planner-context.ts',
      'autonomous-task-planner-system-prompt.ts',
      'autonomous-task-decision.ts',
      'autonomous-task-planner-runtime.ts',
    ];
    const forbidden = [
      'BrowserAdapter',
      'ElectronBrowserAdapter',
      'AgentRunCoordinator',
      'SafeAgentLoop',
      'AgentRunController',
      'InteractionExecutor',
      'ApprovalManager',
      'PrepareActionService',
      'ExecuteExecutor',
      'ApprovalWorkflowController',
      'ipcMain',
      "from 'electron'",
      'from "electron"',
      "from 'react'",
      'from "react"',
      'WebContents',
    ];
    for (const file of files) {
      const source = readFileSync(path.join(__dirname, file), 'utf8');
      for (const needle of forbidden) {
        assert.equal(source.includes(needle), false, `${file} contains ${needle}`);
      }
    }
  });
});
