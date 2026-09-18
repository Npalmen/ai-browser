import { randomUUID } from 'node:crypto';

import { modelContextFits } from '../ai/context-builder';
import { MODEL_CATALOG, getModelProfile, type ModelCatalog } from '../ai/model-catalog';
import { ModelError } from '../ai/model-errors';
import { routeModelRequest } from '../ai/model-router';
import type { ModelAlias, ModelMessage, ModelProfile, ModelRequest } from '../ai/model-types';
import { AutonomousTaskCoordinator } from './autonomous-task-coordinator';
import { AutonomousTaskError } from './autonomous-task-errors';
import {
  parseAutonomousTaskDecision,
  type AutonomousTaskDecision,
} from './autonomous-task-decision';
import type { AutonomousTaskPlannerRuntime } from './autonomous-task-planner-runtime';
import {
  buildAutonomousTaskPlannerMessages,
  estimateAutonomousTaskPlannerInputTokens,
  type AutonomousTaskPlannerInput,
  type AutonomousTaskPlannerMessageContext,
  type ModelSubgoalResult,
  type TrustedTaskProgressEntry,
} from './autonomous-task-planner-context';
import {
  isAutonomousTaskApplied,
  type AutonomousTaskId,
  type AutonomousTaskRef,
  type AutonomousTaskSnapshot,
} from './autonomous-task-types';

export const MAX_AUTONOMOUS_TASK_MODEL_ATTEMPTS = 2;

const FALLBACK_ELIGIBLE_CODES = new Set<ModelError['code']>([
  'MODEL_UNAVAILABLE',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_OUTPUT_INVALID',
]);

export interface AutonomousTaskPlannerDependencies {
  coordinator: AutonomousTaskCoordinator;
  runtime: AutonomousTaskPlannerRuntime;
  catalog?: ModelCatalog;
  generateRequestId?: () => string;
}

export type AutonomousTaskPlannerResult =
  | {
      readonly status: 'decision';
      readonly decision: AutonomousTaskDecision;
      readonly alias: ModelAlias;
    }
  | {
      readonly status: 'ignored';
    };

export class AutonomousTaskPlanner {
  private readonly coordinator: AutonomousTaskCoordinator;
  private readonly runtime: AutonomousTaskPlannerRuntime;
  private readonly catalog: ModelCatalog;
  private readonly generateRequestId: () => string;

  constructor(dependencies: AutonomousTaskPlannerDependencies) {
    this.coordinator = dependencies.coordinator;
    this.runtime = dependencies.runtime;
    this.catalog = dependencies.catalog ?? MODEL_CATALOG;
    this.generateRequestId = dependencies.generateRequestId ?? randomUUID;
  }

  async plan(
    ref: AutonomousTaskRef,
    input: AutonomousTaskPlannerInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<AutonomousTaskPlannerResult> {
    const signal = options.signal ?? new AbortController().signal;
    throwIfCancelled(signal);

    const inspected = this.coordinator.inspectTask(ref);
    if (inspected.status !== 'current') {
      return { status: 'ignored' };
    }
    if (inspected.snapshot.state !== 'planning') {
      throw new AutonomousTaskError(
        'AUTONOMOUS_TASK_INVALID_TRANSITION',
        `AutonomousTask ${ref.taskId} must be planning to invoke the planner.`,
      );
    }

    const budgetCheck = this.coordinator.assertCanStartPlannerStep(ref);
    if (budgetCheck.status === 'ignored') {
      return { status: 'ignored' };
    }
    if (isAutonomousTaskApplied(budgetCheck) && budgetCheck.snapshot.state === 'blocked') {
      throw new ModelError(
        'MODEL_REQUEST_FAILED',
        'Autonomous task planner step budget is exhausted.',
      );
    }

    throwIfCancelled(signal);
    this.validateEphemeralAliases(ref.taskId, input);
    const messageContext = this.buildTrustedMessageContext(ref, inspected.snapshot, input);
    const prepared = this.prepareModelCall(messageContext);
    throwIfCancelled(signal);

    const generated = await this.generateWithFallback({
      signal,
      prepared,
      ref,
    });
    if (generated.status === 'ignored') {
      return { status: 'ignored' };
    }
    const { decision, alias } = generated;
    throwIfCancelled(signal);

    const validated = this.validateDecisionForTask(ref.taskId, decision);
    throwIfCancelled(signal);

    if (!this.coordinator.isCurrentTask(ref)) {
      return { status: 'ignored' };
    }

    const recorded = this.coordinator.recordPlannerStepCompleted(ref);
    if (recorded.status === 'ignored') {
      return { status: 'ignored' };
    }

    return {
      status: 'decision',
      decision: validated,
      alias,
    };
  }

  private buildTrustedMessageContext(
    ref: AutonomousTaskRef,
    snapshot: AutonomousTaskSnapshot,
    input: AutonomousTaskPlannerInput,
  ): AutonomousTaskPlannerMessageContext {
    return {
      snapshot,
      ownedTabs: this.coordinator.getOwnedTabs(ref.taskId).map((tab) => ({
        alias: tab.alias,
        ownershipKind: tab.ownershipKind,
      })),
      trustedProgress: input.trustedProgress,
      modelSubgoalResults: input.modelSubgoalResults,
      userClarification: input.userClarification,
    };
  }

  private validateEphemeralAliases(
    taskId: AutonomousTaskId,
    input: AutonomousTaskPlannerInput,
  ): void {
    for (const entry of input.trustedProgress ?? []) {
      this.requireOwnedTaskTabAlias(taskId, entry.taskTabAlias, 'trusted progress');
    }
    for (const result of input.modelSubgoalResults ?? []) {
      this.requireOwnedTaskTabAlias(taskId, result.taskTabAlias, 'model subgoal result');
    }
  }

  private requireOwnedTaskTabAlias(
    taskId: AutonomousTaskId,
    alias: string,
    source: string,
  ): void {
    if (this.coordinator.resolveTaskTabAlias(taskId, alias) === undefined) {
      throw new ModelError(
        'MODEL_REQUEST_FAILED',
        `Planner ${source} references unknown task tab alias: ${alias}`,
      );
    }
  }

  private isCurrentPlanningTask(ref: AutonomousTaskRef): boolean {
    const inspected = this.coordinator.inspectTask(ref);
    return inspected.status === 'current' && inspected.snapshot.state === 'planning';
  }

  private validateDecisionForTask(
    taskId: AutonomousTaskId,
    decision: AutonomousTaskDecision,
  ): AutonomousTaskDecision {
    if (decision.kind !== 'delegate-subgoal') {
      return decision;
    }
    const owned = this.coordinator.resolveTaskTabAlias(taskId, decision.taskTabAlias);
    if (owned === undefined) {
      throw new ModelError(
        'MODEL_OUTPUT_INVALID',
        `Planner selected unknown task tab alias: ${decision.taskTabAlias}`,
      );
    }
    return decision;
  }

  private prepareModelCall(context: AutonomousTaskPlannerMessageContext): PreparedModelCall {
    const messages = buildAutonomousTaskPlannerMessages(context);
    let route = routeModelRequest(
      {
        taskClass: 'page_analysis',
        needsVision: false,
        privacy: 'remoteAllowed',
        estimatedInputTokens: estimateAutonomousTaskPlannerInputTokens(messages),
      },
      this.catalog,
    );

    let prepared = this.buildFinalCall(route.profile, messages);
    if (!modelContextFits(route.profile, prepared.estimatedInputTokens)) {
      const rerouted = routeModelRequest(
        {
          taskClass: 'page_analysis',
          needsVision: false,
          privacy: 'remoteAllowed',
          estimatedInputTokens: prepared.estimatedInputTokens,
        },
        this.catalog,
      );
      if (rerouted.alias !== route.alias) {
        route = rerouted;
        prepared = this.buildFinalCall(route.profile, messages);
      }
      if (!modelContextFits(route.profile, prepared.estimatedInputTokens)) {
        throw new ModelError(
          'CONTEXT_TOO_LARGE',
          'The final planner input does not fit the selected profile.',
        );
      }
    }

    return prepared;
  }

  private buildFinalCall(profile: ModelProfile, messages: ModelMessage[]): PreparedModelCall {
    return {
      profile,
      messages,
      estimatedInputTokens: estimateAutonomousTaskPlannerInputTokens(messages),
    };
  }

  private async generateWithFallback(input: {
    signal: AbortSignal;
    prepared: PreparedModelCall;
    ref: AutonomousTaskRef;
  }): Promise<
    | { status: 'ignored' }
    | { status: 'decision'; decision: AutonomousTaskDecision; alias: ModelAlias }
  > {
    let prepared = input.prepared;
    let lastError: ModelError | undefined;

    for (let attempt = 1; attempt <= MAX_AUTONOMOUS_TASK_MODEL_ATTEMPTS; attempt += 1) {
      if (!this.isCurrentPlanningTask(input.ref)) {
        return { status: 'ignored' };
      }
      const result = await this.attemptGenerate(prepared, input.signal);
      if (result.ok) {
        return { status: 'decision', decision: result.decision, alias: prepared.profile.alias };
      }
      lastError = result.error;
      throwIfCancelled(input.signal);
      if (attempt === MAX_AUTONOMOUS_TASK_MODEL_ATTEMPTS) {
        break;
      }
      const fallback = this.eligibleFallback(result.error, prepared);
      if (!fallback) {
        break;
      }
      prepared = fallback;
    }

    throw lastError ?? cancelledError();
  }

  private eligibleFallback(
    error: ModelError,
    prepared: PreparedModelCall,
  ): PreparedModelCall | undefined {
    if (!FALLBACK_ELIGIBLE_CODES.has(error.code)) {
      return undefined;
    }
    const fallbackAlias = prepared.profile.fallbackAlias;
    if (fallbackAlias === undefined) {
      return undefined;
    }
    const fallbackProfile = getModelProfile(fallbackAlias, this.catalog);
    if (fallbackProfile.capabilities.text !== true) {
      return undefined;
    }
    const rebuilt = this.buildFinalCall(fallbackProfile, prepared.messages);
    if (!modelContextFits(fallbackProfile, rebuilt.estimatedInputTokens)) {
      return undefined;
    }
    return rebuilt;
  }

  private async attemptGenerate(
    prepared: PreparedModelCall,
    signal: AbortSignal,
  ): Promise<AttemptResult> {
    throwIfCancelled(signal);
    const request: ModelRequest = {
      requestId: this.generateRequestId(),
      messages: prepared.messages,
      profile: prepared.profile,
    };
    try {
      const response = await this.runtime.generateAutonomousTaskDecision(request, { signal });
      throwIfCancelled(signal);
      const decision = parseAutonomousTaskDecision(response.decision);
      throwIfCancelled(signal);
      return { ok: true, decision };
    } catch (error) {
      if (error instanceof ModelError) {
        return { ok: false, error };
      }
      throw error;
    }
  }
}

interface PreparedModelCall {
  profile: ModelProfile;
  messages: ModelMessage[];
  estimatedInputTokens: number;
}

type AttemptResult =
  | { ok: true; decision: AutonomousTaskDecision }
  | { ok: false; error: ModelError };

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError();
  }
}

function cancelledError(): ModelError {
  return new ModelError('REQUEST_CANCELLED', 'The request was cancelled.');
}

export type { AutonomousTaskPlannerInput, TrustedTaskProgressEntry, ModelSubgoalResult };
