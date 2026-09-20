import type { InteractiveStepAgent, InteractiveStepRequest } from '../ai/interactive-step-agent';
import { DEFAULT_TASK_COMPLETION_TEXT } from '../ai/interaction-output-schema';
import { logAgentLoopModelStepFailed } from '../ai/model-diagnostics';
import { ModelError, type ModelErrorCode } from '../ai/model-errors';
import type { ModelAlias, ModelPrivacyRequirement, TaskClass } from '../ai/model-types';
import type { TrustedRunProgressEntry } from '../ai/trusted-run-progress';
import { InteractionError, type InteractionErrorCode } from '../shared/interaction-errors';
import type { TabId } from '../shared/browser-types';
import type {
  BoundInteractionProposal,
  InteractionResult,
} from '../shared/interaction-types';
import type { DocumentRevision, PageObservation, TargetId } from '../shared/observation-types';
import { ObservationError, type ObservationErrorCode } from '../shared/observation-types';
import { MAX_VIEWPORT_DISCOVERY_SCROLLS } from '../shared/viewport-discovery-policy';
import { fingerprintBoundProposal } from './bound-proposal-fingerprint';
import type { AgentRunCoordinator } from './agent-run-coordinator';
import type { AgentRunApprovalPort } from './approval-pause-port';
import {
  isTerminalAgentRunState,
  MAX_AGENT_LOOP_SEMANTIC_ACTIONS,
  type AgentRunBlockedReason,
  type AgentRunMutationResult,
  type AgentRunRef,
  type AgentRunSnapshot,
} from './agent-run-types';

export interface SafeV3InteractionExecutionPort {
  execute(input: {
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): Promise<InteractionResult>;
}

export interface SafeAgentLoopDependencies {
  coordinator: AgentRunCoordinator;
  stepAgent: Pick<InteractiveStepAgent, 'step'>;
  interactionExecutor: SafeV3InteractionExecutionPort;
  approvalPort?: AgentRunApprovalPort;
}

export interface SafeAgentLoopOptions {
  readonly signal?: AbortSignal;
  readonly taskClass?: TaskClass;
  readonly needsVision?: boolean;
  readonly privacy?: ModelPrivacyRequirement;
  readonly onAnswerTextDelta?: (text: string) => void;
  readonly priorConversationForRevision?: (
    tabId: TabId,
    revision: DocumentRevision,
  ) => string;
  readonly onContinuing?: (snapshot: AgentRunSnapshot) => void;
  readonly onAwaitingApproval?: (snapshot: AgentRunSnapshot) => void;
}

export type SafeAgentLoopResult =
  | {
      readonly status: 'completed';
      readonly run: AgentRunSnapshot;
      readonly answer: {
        readonly text: string;
        readonly referencedTargets: readonly TargetId[];
        readonly alias: ModelAlias;
        readonly truncatedContext: boolean;
        readonly documentRevision: DocumentRevision;
      };
    }
  | {
      readonly status: 'terminal';
      readonly run: AgentRunSnapshot;
    }
  | {
      readonly status: 'ignored';
    };

interface PostNavigationContinuation {
  trustedObservation: PageObservation | undefined;
  observationRetriesRemaining: number;
}

interface RunLocalBudgets {
  consecutiveViewportScrolls: number;
  semanticActionAttempts: number;
}

function createPostNavigationContinuation(): PostNavigationContinuation {
  return {
    trustedObservation: undefined,
    observationRetriesRemaining: 0,
  };
}

function createRunLocalBudgets(): RunLocalBudgets {
  return {
    consecutiveViewportScrolls: 0,
    semanticActionAttempts: 0,
  };
}

function isViewportDiscoveryScroll(proposal: BoundInteractionProposal): boolean {
  return proposal.kind === 'scroll' && proposal.mode === 'viewport';
}

function shouldCompleteOnTrustedSuccess(
  step: Extract<Awaited<ReturnType<InteractiveStepAgent['step']>>, { kind: 'proposal' }>,
): boolean {
  return step.continuation === 'complete-on-success' && step.proposal.kind !== 'scroll';
}

export class SafeAgentLoop {
  private readonly coordinator: AgentRunCoordinator;
  private readonly stepAgent: Pick<InteractiveStepAgent, 'step'>;
  private readonly interactionExecutor: SafeV3InteractionExecutionPort;
  private readonly approvalPort: AgentRunApprovalPort | undefined;

  constructor(deps: SafeAgentLoopDependencies) {
    this.coordinator = deps.coordinator;
    this.stepAgent = deps.stepAgent;
    this.interactionExecutor = deps.interactionExecutor;
    this.approvalPort = deps.approvalPort;
  }

  async run(ref: AgentRunRef, options: SafeAgentLoopOptions = {}): Promise<SafeAgentLoopResult> {
    const runSnapshot = this.coordinator.getRun(ref.runId);
    if (runSnapshot === undefined) {
      return { status: 'ignored' };
    }

    const trustedProgress: TrustedRunProgressEntry[] = [];
    const continuation = createPostNavigationContinuation();
    const budgets = createRunLocalBudgets();
    let modelIteration = 0;

    while (true) {
      const current = this.requireCurrentRun(ref);
      if (current.status !== 'current') {
        return current.result;
      }

      const cancelled = this.cancelIfAborted(ref, options.signal);
      if (cancelled !== undefined) {
        return cancelled;
      }

      const budget = this.coordinator.assertCanStartModelStep(ref);
      const budgetStop = this.terminalFromMutation(budget);
      if (budgetStop !== undefined) {
        return budgetStop;
      }

      const liveRun = this.coordinator.getRun(ref.runId);
      if (liveRun === undefined) {
        return { status: 'ignored' };
      }

      let step;
      const modelStepIteration = modelIteration + 1;
      const postNavigation =
        continuation.trustedObservation !== undefined ||
        continuation.observationRetriesRemaining > 0;
      try {
        const trustedObservation = continuation.trustedObservation;
        continuation.trustedObservation = undefined;
        step = await this.stepAgent.step(this.buildStepRequest(liveRun, options), {
          signal: options.signal,
          onAnswerTextDelta: options.onAnswerTextDelta,
          trustedProgress: trustedProgress.length > 0 ? trustedProgress : undefined,
          priorConversationForRevision:
            modelIteration === 0 ? options.priorConversationForRevision : undefined,
          ...(trustedObservation !== undefined ? { trustedObservation } : {}),
        });
      } catch (error) {
        if (shouldRetryPostNavigationObservation(error, continuation.observationRetriesRemaining)) {
          continuation.observationRetriesRemaining -= 1;
          console.log('[agent-loop] post-navigation-observation-retry');
          continue;
        }
        return this.handleStepError(ref, error, {
          iteration: modelStepIteration,
          postNavigation,
        });
      }

      if (!this.coordinator.isCurrentRun(ref)) {
        return { status: 'ignored' };
      }

      const recorded = this.coordinator.recordModelStepCompleted(ref);
      const recordedStop = this.terminalFromMutation(recorded);
      if (recordedStop !== undefined) {
        return recordedStop;
      }

      modelIteration += 1;

      if (step.kind === 'answer') {
        const completed = this.coordinator.markCompleted(ref);
        if (completed.status === 'ignored') {
          return { status: 'ignored' };
        }
        if (completed.snapshot.state !== 'completed') {
          return { status: 'terminal', run: completed.snapshot };
        }
        return {
          status: 'completed',
          run: completed.snapshot,
          answer: {
            text: step.text,
            referencedTargets: step.referencedTargets,
            alias: step.alias,
            truncatedContext: step.truncatedContext,
            documentRevision: step.observation.document.revision,
          },
        };
      }

      if (isViewportDiscoveryScroll(step.proposal)) {
        if (budgets.consecutiveViewportScrolls >= MAX_VIEWPORT_DISCOVERY_SCROLLS) {
          return this.blockTerminal(ref, 'AGENT_LOOP_NO_PROGRESS');
        }
      } else if (budgets.semanticActionAttempts >= MAX_AGENT_LOOP_SEMANTIC_ACTIONS) {
        return this.blockTerminal(ref, 'STEP_LIMIT_REACHED');
      }

      const fingerprint = fingerprintBoundProposal(step.proposal, step.observation);

      const originPopupRepeat = this.coordinator.assertNotRepeatOriginPopupClick(
        ref,
        step.proposal.tabId,
        step.proposal.kind,
      );
      const originPopupRepeatStop = this.terminalFromMutation(originPopupRepeat);
      if (originPopupRepeatStop !== undefined) {
        return originPopupRepeatStop;
      }

      const noProgress = this.coordinator.assertNoImmediateRepeat(ref, fingerprint);
      const noProgressStop = this.terminalFromMutation(noProgress);
      if (noProgressStop !== undefined) {
        return noProgressStop;
      }

      const actionBudget = this.coordinator.beginActionAttempt(ref);
      const actionBudgetStop = this.terminalFromMutation(actionBudget);
      if (actionBudgetStop !== undefined) {
        return actionBudgetStop;
      }

      if (!isViewportDiscoveryScroll(step.proposal)) {
        budgets.semanticActionAttempts += 1;
      }

      const result = await this.interactionExecutor.execute({
        proposal: step.proposal,
        observation: step.observation,
        signal: options.signal,
      });

      if (!this.coordinator.isCurrentRun(ref)) {
        return { status: 'ignored' };
      }

      const actionOutcome = await this.handleInteractionResult(
        ref,
        step,
        result,
        trustedProgress,
        options,
        continuation,
        budgets,
      );
      if (actionOutcome !== undefined) {
        return actionOutcome;
      }

      const cancelledAfterAction = this.cancelIfAborted(ref, options.signal);
      if (cancelledAfterAction !== undefined) {
        return cancelledAfterAction;
      }

      this.notifyContinuing(ref, options);
    }
  }

  private buildStepRequest(
    run: AgentRunSnapshot,
    options: SafeAgentLoopOptions,
  ): InteractiveStepRequest {
    return {
      tabId: run.executionTabId ?? run.tabId,
      instruction: run.instruction,
      ...(options.taskClass !== undefined ? { taskClass: options.taskClass } : {}),
      ...(options.needsVision === true ? { needsVision: true } : {}),
      ...(options.privacy !== undefined ? { privacy: options.privacy } : {}),
    };
  }

  private requireCurrentRun(
    ref: AgentRunRef,
  ): { status: 'current' } | { status: 'stopped'; result: SafeAgentLoopResult } {
    const inspected = this.coordinator.inspectRun(ref);
    if (inspected.status === 'current') {
      return { status: 'current' };
    }
    if (inspected.status === 'terminal' || inspected.status === 'superseded') {
      return { status: 'stopped', result: { status: 'terminal', run: inspected.snapshot } };
    }
    return { status: 'stopped', result: { status: 'ignored' } };
  }

  private cancelIfAborted(ref: AgentRunRef, signal?: AbortSignal): SafeAgentLoopResult | undefined {
    if (!signal?.aborted) {
      return undefined;
    }
    if (!this.coordinator.isCurrentRun(ref)) {
      return { status: 'ignored' };
    }
    const cancelled = this.coordinator.cancelRun(ref, 'USER_CANCELLED');
    return this.terminalFromMutation(cancelled) ?? { status: 'ignored' };
  }

  private handleStepError(
    ref: AgentRunRef,
    error: unknown,
    context?: { iteration: number; postNavigation: boolean },
  ): SafeAgentLoopResult {
    if (error instanceof ModelError) {
      if (error.code === 'REQUEST_CANCELLED') {
        if (this.coordinator.isCurrentRun(ref)) {
          const cancelled = this.coordinator.cancelRun(ref, 'USER_CANCELLED');
          return this.terminalFromMutation(cancelled) ?? { status: 'ignored' };
        }
        return { status: 'ignored' };
      }
      logAgentLoopModelStepFailed({
        code: error.code,
        iteration: context?.iteration ?? 0,
        postNavigation: context?.postNavigation ?? false,
        alias: error.alias,
        fallbackAttempts: error.fallbackAttempts,
        category: error.category,
        failurePhase: error.failurePhase,
        providerStatus: error.providerStatus,
      });
      return this.failTerminal(ref, 'MODEL_FAILED', error.code);
    }

    if (error instanceof ObservationError) {
      if (isObservationStale(error.code)) {
        return this.blockTerminal(ref, 'ACTION_STALE');
      }
      return this.failTerminal(ref, 'ACTION_FAILED');
    }

    if (error instanceof InteractionError) {
      return this.handleBindingError(ref, error.code);
    }

    return this.failTerminal(ref, 'ACTION_FAILED');
  }

  private async handleInteractionResult(
    ref: AgentRunRef,
    step: Extract<Awaited<ReturnType<InteractiveStepAgent['step']>>, { kind: 'proposal' }>,
    result: InteractionResult,
    trustedProgress: TrustedRunProgressEntry[],
    options: SafeAgentLoopOptions,
    continuation: PostNavigationContinuation,
    budgets: RunLocalBudgets,
  ): Promise<SafeAgentLoopResult | undefined> {
    if (result.status === 'succeeded') {
      return this.handleSucceededAction(
        ref,
        step,
        result,
        trustedProgress,
        continuation,
        budgets,
      );
    }
    if (result.status === 'denied') {
      return this.handleDeniedAction(ref, step, result.errorCode, trustedProgress, options);
    }
    if (result.status === 'execution-state-unknown') {
      return this.unknownTerminal(ref);
    }
    return this.handleFailedAction(ref, result.errorCode);
  }

  private handleSucceededAction(
    ref: AgentRunRef,
    step: Extract<Awaited<ReturnType<InteractiveStepAgent['step']>>, { kind: 'proposal' }>,
    result: InteractionResult,
    trustedProgress: TrustedRunProgressEntry[],
    continuation: PostNavigationContinuation,
    budgets: RunLocalBudgets,
  ): SafeAgentLoopResult | undefined {
    const postObservation = result.observation;
    const live = this.coordinator.getRun(ref.runId);
    const executionTabId = live?.executionTabId ?? ref.tabId;
    const popup = result.navigation;
    const causalPopup =
      popup?.kind === 'popup' &&
      popup.sourceTabId === ref.tabId &&
      popup.destinationTabId !== ref.tabId &&
      postObservation?.tabId === popup.destinationTabId;

    if (postObservation === undefined) {
      return this.failTerminal(ref, 'ACTION_FAILED');
    }
    if (
      !causalPopup &&
      postObservation.tabId !== executionTabId &&
      postObservation.tabId !== ref.tabId
    ) {
      return this.failTerminal(ref, 'ACTION_FAILED');
    }

    if (causalPopup) {
      const adopted = this.coordinator.adoptCausalPopup(ref, popup.destinationTabId);
      if (adopted.status === 'ignored') {
        return this.failTerminal(ref, 'ACTION_FAILED');
      }
      const adoptStop = this.terminalFromMutation(adopted);
      if (adoptStop !== undefined) {
        return adoptStop;
      }
    }

    const revisionChanged =
      postObservation.document.revision !== step.observation.document.revision;
    const urlChanged = postObservation.document.url !== step.observation.document.url;
    const navigated =
      causalPopup === true ||
      (step.proposal.kind === 'click' && (revisionChanged || urlChanged));
    const fingerprint = fingerprintBoundProposal(step.proposal, step.observation);

    const recordedFingerprint = this.coordinator.recordSuccessfulActionFingerprint(
      ref,
      fingerprint,
    );
    const fingerprintStop = this.terminalFromMutation(recordedFingerprint);
    if (fingerprintStop !== undefined) {
      return fingerprintStop;
    }

    if (navigated) {
      trustedProgress.push({
        kind: 'safe-navigation-succeeded',
        pageChanged: true,
        sameDocument: causalPopup !== true && !revisionChanged,
      });
      budgets.consecutiveViewportScrolls = 0;
    } else if (isViewportDiscoveryScroll(step.proposal)) {
      budgets.consecutiveViewportScrolls += 1;
      trustedProgress.push({
        kind: 'safe-interaction-succeeded',
        actionKind: step.proposal.kind,
        pageChanged: revisionChanged,
      });
    } else {
      budgets.consecutiveViewportScrolls = 0;
      trustedProgress.push({
        kind: 'safe-interaction-succeeded',
        actionKind: step.proposal.kind,
        pageChanged: revisionChanged,
      });
    }

    if (navigated) {
      continuation.observationRetriesRemaining = 1;
      continuation.trustedObservation =
        causalPopup === true || urlChanged ? postObservation : undefined;
    } else {
      continuation.observationRetriesRemaining = 0;
      continuation.trustedObservation = undefined;
    }

    if (shouldCompleteOnTrustedSuccess(step)) {
      return this.completeAfterTrustedSuccess(ref, step, postObservation);
    }

    return undefined;
  }

  private async handleDeniedAction(
    ref: AgentRunRef,
    step: Extract<Awaited<ReturnType<InteractiveStepAgent['step']>>, { kind: 'proposal' }>,
    errorCode: InteractionErrorCode | undefined,
    trustedProgress: TrustedRunProgressEntry[],
    options: SafeAgentLoopOptions,
  ): Promise<SafeAgentLoopResult | undefined> {
    if (errorCode === 'DEFERRED_TO_EXECUTE') {
      return this.handleDeferredExecute(ref, step, trustedProgress, options);
    }
    if (errorCode === 'UNSUPPORTED_TARGET' && step.proposal.kind !== 'click') {
      return this.blockTerminal(ref, 'UNSUPPORTED_ACTION');
    }
    if (isReplannableTargetSelectionDenial(errorCode, step.proposal.kind)) {
      return this.continueAfterTargetSelectionDenial(ref, step, trustedProgress);
    }
    if (errorCode === 'UNSUPPORTED_TARGET') {
      return this.blockTerminal(ref, 'UNSUPPORTED_ACTION');
    }
    if (isPolicyDenial(errorCode)) {
      return this.blockTerminal(ref, 'POLICY_BLOCKED');
    }
    return this.blockTerminal(ref, 'POLICY_BLOCKED');
  }

  private continueAfterTargetSelectionDenial(
    ref: AgentRunRef,
    step: Extract<Awaited<ReturnType<InteractiveStepAgent['step']>>, { kind: 'proposal' }>,
    trustedProgress: TrustedRunProgressEntry[],
  ): SafeAgentLoopResult | undefined {
    const recordedFingerprint = this.coordinator.recordSuccessfulActionFingerprint(
      ref,
      fingerprintBoundProposal(step.proposal, step.observation),
    );
    const fingerprintStop = this.terminalFromMutation(recordedFingerprint);
    if (fingerprintStop !== undefined) {
      return fingerprintStop;
    }

    trustedProgress.push({
      kind: 'target-selection-denied',
      actionKind: step.proposal.kind,
    });
    return undefined;
  }

  private async handleDeferredExecute(
    ref: AgentRunRef,
    step: Extract<Awaited<ReturnType<InteractiveStepAgent['step']>>, { kind: 'proposal' }>,
    trustedProgress: TrustedRunProgressEntry[],
    options: SafeAgentLoopOptions,
  ): Promise<SafeAgentLoopResult | undefined> {
    const signal = options.signal;
    if (this.approvalPort === undefined || step.proposal.kind !== 'click') {
      return this.blockTerminal(ref, 'UNSUPPORTED_ACTION');
    }
    if (!this.coordinator.isCurrentRun(ref)) {
      return { status: 'ignored' };
    }
    if (signal?.aborted) {
      return this.cancelIfAborted(ref, signal) ?? { status: 'ignored' };
    }
    if (!this.coordinator.canPrepareAnotherAction(ref)) {
      return this.blockTerminal(ref, 'STEP_LIMIT_REACHED');
    }

    let prepared;
    try {
      prepared = this.approvalPort.prepareAndPresent({
        ref,
        proposal: step.proposal,
        observation: step.observation,
        signal,
      });
    } catch {
      return this.failTerminal(ref, 'ACTION_FAILED');
    }

    if (prepared.status === 'awaiting-approval') {
      this.notifyAwaitingApproval(ref, options);
      return this.waitForApprovedResume(
        ref,
        step,
        prepared.approvalId,
        trustedProgress,
        signal,
      );
    }
    if (prepared.status === 'expired') {
      return this.blockTerminal(ref, 'APPROVAL_EXPIRED');
    }
    if (prepared.status === 'stale') {
      return this.blockTerminal(ref, 'ACTION_STALE');
    }
    if (prepared.status === 'failed') {
      return this.failTerminal(ref, 'ACTION_FAILED');
    }

    const inspected = this.coordinator.inspectRun(ref);
    if (inspected.status === 'terminal' || inspected.status === 'superseded') {
      return { status: 'terminal', run: inspected.snapshot };
    }
    return { status: 'ignored' };
  }

  private async waitForApprovedResume(
    ref: AgentRunRef,
    step: Extract<Awaited<ReturnType<InteractiveStepAgent['step']>>, { kind: 'proposal' }>,
    approvalId: string,
    trustedProgress: TrustedRunProgressEntry[],
    signal?: AbortSignal,
  ): Promise<SafeAgentLoopResult | undefined> {
    const onAbort = () => {
      this.cancelIfAborted(ref, signal);
    };
    signal?.addEventListener('abort', onAbort);
    try {
      if (signal?.aborted) {
        const cancelled = this.cancelIfAborted(ref, signal);
        if (cancelled !== undefined) {
          return cancelled;
        }
      }

      const waited = await this.coordinator.waitForApprovalOutcome(approvalId, ref.generation);
      if (waited.status === 'ignored') {
        return { status: 'ignored' };
      }
      if (waited.snapshot.state === 'running') {
        if (!this.coordinator.isCurrentRun(ref)) {
          return { status: 'ignored' };
        }
        const fingerprint = fingerprintBoundProposal(step.proposal, step.observation);
        const recorded = this.coordinator.recordSuccessfulActionFingerprint(ref, fingerprint);
        const fingerprintStop = this.terminalFromMutation(recorded);
        if (fingerprintStop !== undefined) {
          return fingerprintStop;
        }
        trustedProgress.push({
          kind: 'approved-execution-succeeded',
        });
        if (shouldCompleteOnTrustedSuccess(step)) {
          const observation = step.observation;
          return this.completeAfterTrustedSuccess(ref, step, observation);
        }
        return undefined;
      }
      if (isTerminalAgentRunState(waited.snapshot.state)) {
        return { status: 'terminal', run: waited.snapshot };
      }
      return { status: 'ignored' };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private notifyContinuing(ref: AgentRunRef, options: SafeAgentLoopOptions): void {
    if (options.onContinuing === undefined) {
      return;
    }
    const inspected = this.coordinator.inspectRun(ref);
    if (inspected.status === 'current') {
      options.onContinuing(inspected.snapshot);
    }
  }

  private notifyAwaitingApproval(ref: AgentRunRef, options: SafeAgentLoopOptions): void {
    if (options.onAwaitingApproval === undefined) {
      return;
    }
    const inspected = this.coordinator.inspectRun(ref);
    if (inspected.status === 'current' && inspected.snapshot.state === 'awaiting-approval') {
      options.onAwaitingApproval(inspected.snapshot);
    }
  }

  private handleFailedAction(
    ref: AgentRunRef,
    errorCode?: InteractionErrorCode,
  ): SafeAgentLoopResult {
    if (errorCode === 'REQUEST_CANCELLED') {
      if (this.coordinator.isCurrentRun(ref)) {
        const cancelled = this.coordinator.cancelRun(ref, 'USER_CANCELLED');
        return this.terminalFromMutation(cancelled) ?? { status: 'ignored' };
      }
      return { status: 'ignored' };
    }
    if (isInteractionStale(errorCode)) {
      return this.blockTerminal(ref, 'ACTION_STALE');
    }
    return this.failTerminal(ref, 'ACTION_FAILED');
  }

  private handleBindingError(
    ref: AgentRunRef,
    errorCode: InteractionErrorCode,
  ): SafeAgentLoopResult {
    if (isInteractionStale(errorCode)) {
      return this.blockTerminal(ref, 'ACTION_STALE');
    }
    if (isPolicyBindingError(errorCode)) {
      return this.blockTerminal(ref, 'POLICY_BLOCKED');
    }
    return this.failTerminal(ref, 'ACTION_FAILED');
  }

  private completeAfterTrustedSuccess(
    ref: AgentRunRef,
    step: Extract<Awaited<ReturnType<InteractiveStepAgent['step']>>, { kind: 'proposal' }>,
    observation: PageObservation,
  ): SafeAgentLoopResult {
    const completed = this.coordinator.markCompleted(ref);
    if (completed.status === 'ignored') {
      return { status: 'ignored' };
    }
    if (completed.snapshot.state !== 'completed') {
      return { status: 'terminal', run: completed.snapshot };
    }
    return {
      status: 'completed',
      run: completed.snapshot,
      answer: {
        text: step.onSuccessText ?? DEFAULT_TASK_COMPLETION_TEXT,
        referencedTargets: [],
        alias: step.alias,
        truncatedContext: step.truncatedContext,
        documentRevision: observation.document.revision,
      },
    };
  }

  private blockTerminal(ref: AgentRunRef, reason: AgentRunBlockedReason): SafeAgentLoopResult {
    if (!this.coordinator.isCurrentRun(ref)) {
      return { status: 'ignored' };
    }
    const blocked = this.coordinator.markBlocked(ref, reason);
    return this.terminalFromMutation(blocked) ?? { status: 'ignored' };
  }

  private failTerminal(
    ref: AgentRunRef,
    reason: 'MODEL_FAILED' | 'ACTION_FAILED',
    modelErrorCode?: ModelErrorCode,
  ): SafeAgentLoopResult {
    if (!this.coordinator.isCurrentRun(ref)) {
      return { status: 'ignored' };
    }
    const failed = this.coordinator.markFailed(
      ref,
      reason,
      reason === 'MODEL_FAILED' && modelErrorCode !== undefined
        ? { modelErrorCode }
        : undefined,
    );
    return this.terminalFromMutation(failed) ?? { status: 'ignored' };
  }

  private unknownTerminal(ref: AgentRunRef): SafeAgentLoopResult {
    if (!this.coordinator.isCurrentRun(ref)) {
      return { status: 'ignored' };
    }
    const unknown = this.coordinator.markExecutionStateUnknown(ref);
    return this.terminalFromMutation(unknown) ?? { status: 'ignored' };
  }

  private terminalFromMutation(
    result: AgentRunMutationResult,
  ): SafeAgentLoopResult | undefined {
    if (result.status === 'ignored') {
      return { status: 'ignored' };
    }
    if (isTerminalAgentRunState(result.snapshot.state)) {
      return { status: 'terminal', run: result.snapshot };
    }
    return undefined;
  }

  private requireSnapshot(ref: AgentRunRef): AgentRunSnapshot {
    const snapshot = this.coordinator.getRun(ref.runId);
    if (snapshot === undefined) {
      throw new Error(`AgentRun ${ref.runId} is missing.`);
    }
    return snapshot;
  }
}

function shouldRetryPostNavigationObservation(
  error: unknown,
  observationRetriesRemaining: number,
): boolean {
  if (observationRetriesRemaining <= 0) {
    return false;
  }
  if (!(error instanceof ObservationError)) {
    return false;
  }
  return (
    error.code === 'PAGE_NOT_READY' ||
    error.code === 'PAGE_CHANGED_DURING_OBSERVATION' ||
    error.code === 'OBSERVATION_IN_PROGRESS'
  );
}

function isReplannableTargetSelectionDenial(
  errorCode: InteractionErrorCode | undefined,
  proposalKind: BoundInteractionProposal['kind'],
): boolean {
  if (proposalKind !== 'click') {
    return false;
  }
  return (
    errorCode === 'INTERACTION_DENIED' ||
    errorCode === 'UNSUPPORTED_TARGET' ||
    errorCode === 'TARGET_NOT_INTERACTIVE'
  );
}

function isPolicyDenial(errorCode?: InteractionErrorCode): boolean {
  return (
    errorCode === 'TARGET_SENSITIVE' ||
    errorCode === 'INTERACTION_DENIED' ||
    errorCode === 'TARGET_DISABLED' ||
    errorCode === 'TARGET_NOT_INTERACTIVE' ||
    errorCode === 'TARGET_NOT_EXPORTED'
  );
}

function isPolicyBindingError(errorCode: InteractionErrorCode): boolean {
  return (
    errorCode === 'TARGET_NOT_EXPORTED' ||
    errorCode === 'TARGET_SENSITIVE' ||
    errorCode === 'UNSUPPORTED_TARGET'
  );
}

function isInteractionStale(errorCode?: InteractionErrorCode): boolean {
  return (
    errorCode === 'TARGET_STALE' ||
    errorCode === 'TARGET_NOT_FOUND' ||
    errorCode === 'PAGE_CHANGED' ||
    errorCode === 'TAB_NOT_FOUND'
  );
}

function isObservationStale(errorCode: ObservationErrorCode): boolean {
  return errorCode === 'PAGE_CHANGED_DURING_OBSERVATION' || errorCode === 'TAB_NOT_FOUND';
}
