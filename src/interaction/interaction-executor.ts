import { randomUUID } from 'node:crypto';

import type { BrowserAdapter } from '../browser/browser-adapter';
import type {
  AdapterObservedBounds,
  AdapterTargetRef,
} from '../browser/interaction-adapter-types';
import {
  getNavigationLifecycle,
  navigationWaitToError,
  type NavigationMarker,
  type NavigationWaitResult,
} from '../browser/navigation-lifecycle';
import type { PageState } from '../shared/browser-types';
import { InteractionError, type InteractionErrorCode } from '../shared/interaction-errors';
import type {
  BoundInteractionProposal,
  InteractionGrant,
  InteractionPolicyAllowDecision,
  InteractionPolicyDenyDecision,
  InteractionResult,
} from '../shared/interaction-types';
import {
  ObservationError,
  type ObservationNode,
  type PageObservation,
} from '../shared/observation-types';
import type { TargetRegistry } from '../observation/target-registry';
import {
  buildInteractionAuditEvent,
  type InteractionAuditFailureStage,
  type InteractionAuditResultStatus,
  type InteractionAuditSink,
} from './interaction-audit';
import {
  assertGrantMatchesProposal,
  isAllowPolicyDecision,
  issueInteractionGrant,
} from './interaction-grant';
import { classifyInteraction } from './interaction-policy';
import { resolveInteractionTarget, type ResolvedInteractionTarget } from './target-resolver';

const POST_NAVIGATION_OBSERVATION_ATTEMPTS = 3;
const POST_NAVIGATION_RETRY_DELAY_MS = 50;
const POST_NAVIGATION_WAIT_TIMEOUT_MS = 15_000;

export interface InteractionExecutorDependencies {
  adapter: BrowserAdapter;
  targetRegistry: TargetRegistry;
  audit: InteractionAuditSink;
  generateActionId?: () => string;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  navigationWaitTimeoutMs?: number;
}

export interface ExecuteInteractionInput {
  proposal: BoundInteractionProposal;
  observation: PageObservation;
  signal?: AbortSignal;
}

interface ExecutionStageState {
  decision?: InteractionPolicyAllowDecision | InteractionPolicyDenyDecision;
  grant?: InteractionGrant;
  adapterPrimitiveInvoked: boolean;
}

export class InteractionExecutor {
  private readonly inFlightTabs = new Set<string>();

  constructor(private readonly deps: InteractionExecutorDependencies) {}

  async execute(input: ExecuteInteractionInput): Promise<InteractionResult> {
    const { proposal, observation, signal } = input;
    const actionId = this.deps.generateActionId?.() ?? randomUUID();
    const timestamp = this.deps.now?.() ?? Date.now();

    try {
      this.assertNotCancelled(signal);
    } catch (error: unknown) {
      return this.finishExecutionFailed({
        actionId,
        timestamp,
        proposal,
        error,
        stage: { adapterPrimitiveInvoked: false },
      });
    }

    if (this.inFlightTabs.has(proposal.tabId)) {
      return this.finishExecutionFailed({
        actionId,
        timestamp,
        proposal,
        errorCode: 'INTERACTION_IN_PROGRESS',
        stage: { adapterPrimitiveInvoked: false },
      });
    }

    this.inFlightTabs.add(proposal.tabId);

    try {
      return await this.executeInFlight({ actionId, timestamp, proposal, observation, signal });
    } finally {
      this.inFlightTabs.delete(proposal.tabId);
    }
  }

  private async executeInFlight(input: {
    actionId: string;
    timestamp: number;
    proposal: BoundInteractionProposal;
    observation: PageObservation;
    signal?: AbortSignal;
  }): Promise<InteractionResult> {
    const { actionId, timestamp, proposal, observation, signal } = input;
    const stage: ExecutionStageState = { adapterPrimitiveInvoked: false };

    try {
      this.assertNotCancelled(signal);
      const policyContext = this.buildPolicyContext(proposal, observation);
      const decision = classifyInteraction({
        proposal,
        observation,
        target: policyContext,
      });
      stage.decision = decision;

      if (!isAllowPolicyDecision(decision)) {
        return this.finishPolicyDenied({
          actionId,
          timestamp,
          proposal,
          decision,
        });
      }

      const grant = issueInteractionGrant(decision, proposal, actionId, timestamp);
      stage.grant = grant;
      assertGrantMatchesProposal(grant, proposal);

      const navigationClick = isNavigationClick(proposal, stage);
      const lifecycle = navigationClick ? getNavigationLifecycle(this.deps.adapter) : undefined;
      let navigationMarker: NavigationMarker | undefined;
      if (lifecycle) {
        navigationMarker = lifecycle.captureNavigationMarker(proposal.tabId);
        console.log(
          `[interaction] navigation-marker-captured generation=${navigationMarker.generation} popupGeneration=${navigationMarker.popupGeneration}`,
        );
      }

      stage.adapterPrimitiveInvoked = true;
      await this.dispatchGrantedAction(grant, proposal, observation, policyContext);

      return await this.collectPostActionResult({
        actionId,
        timestamp,
        proposal,
        stage,
        signal,
        navigationMarker,
      });
    } catch (error: unknown) {
      if (stage.adapterPrimitiveInvoked && stage.grant && stage.decision && isAllowPolicyDecision(stage.decision)) {
        return this.finishAfterPrimitive({
          actionId,
          timestamp,
          proposal,
          stage,
          error,
          failureStage: 'adapter-primitive',
        });
      }

      const errorCode = mapExecutionError(error);
      return this.finishExecutionFailed({
        actionId,
        timestamp,
        proposal,
        error,
        stage,
        failureStage: isTargetResolutionFailure(errorCode) ? 'target-resolution' : undefined,
      });
    }
  }

  private async collectPostActionResult(input: {
    actionId: string;
    timestamp: number;
    proposal: BoundInteractionProposal;
    stage: ExecutionStageState;
    signal?: AbortSignal;
    navigationMarker?: NavigationMarker;
  }): Promise<InteractionResult> {
    const navigationClick = isNavigationClick(input.proposal, input.stage);

    try {
      let navigationWait: NavigationWaitResult | undefined;
      if (navigationClick) {
        navigationWait = await this.waitForNavigationTransition({
          tabId: input.proposal.tabId,
          marker: input.navigationMarker,
          signal: input.signal,
        });
      }

      const observeTabId = causalPopupDestinationTabId(navigationWait, input.proposal.tabId);
      const { observation, pageState } = await this.observeAfterAction({
        tabId: observeTabId,
        signal: input.signal,
        retryTransient: navigationClick,
      });

      this.appendAudit({
        actionId: input.actionId,
        timestamp: input.timestamp,
        proposal: input.proposal,
        stage: input.stage,
        resultStatus: 'succeeded',
        documentRevisionAfter: observation.document.revision,
      });

      return {
        actionId: input.actionId,
        status: 'succeeded',
        pageState,
        observation,
        ...(observeTabId !== input.proposal.tabId &&
        navigationWait?.status === 'settled' &&
        navigationWait.kind === 'popup'
          ? {
              navigation: {
                kind: 'popup' as const,
                sourceTabId: navigationWait.sourceTabId,
                destinationTabId: navigationWait.destinationTabId,
              },
            }
          : {}),
      };
    } catch (error: unknown) {
      return this.finishAfterPrimitive({
        actionId: input.actionId,
        timestamp: input.timestamp,
        proposal: input.proposal,
        stage: input.stage,
        error,
        failureStage: 'post-action-observation',
        treatAsUnknown: navigationClick,
      });
    }
  }

  private async observeAfterAction(input: {
    tabId: string;
    signal?: AbortSignal;
    retryTransient: boolean;
  }): Promise<{ observation: PageObservation; pageState: PageState }> {
    const attempts = input.retryTransient ? POST_NAVIGATION_OBSERVATION_ATTEMPTS : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.assertNotCancelled(input.signal);
      try {
        const observation = await this.deps.adapter.observePage(input.tabId);
        const pageState = await this.deps.adapter.getPageState(input.tabId);
        if (
          input.retryTransient &&
          observation.document.loading &&
          attempt < attempts
        ) {
          console.log(`[interaction] post-navigation-observation-retry attempt=${attempt}`);
          await this.sleep(POST_NAVIGATION_RETRY_DELAY_MS, input.signal);
          continue;
        }
        return { observation, pageState };
      } catch (error: unknown) {
        lastError = error;
        if (
          !input.retryTransient ||
          !isTransientPostNavigationObservationError(error) ||
          attempt >= attempts
        ) {
          throw error;
        }
        console.log(`[interaction] post-navigation-observation-retry attempt=${attempt}`);
        await this.sleep(POST_NAVIGATION_RETRY_DELAY_MS, input.signal);
      }
    }

    throw lastError ?? new InteractionError('INTERACTION_FAILED', 'Post-action observation failed.');
  }

  private async waitForNavigationTransition(input: {
    tabId: string;
    marker: NavigationMarker | undefined;
    signal?: AbortSignal;
  }): Promise<NavigationWaitResult | undefined> {
    const lifecycle = getNavigationLifecycle(this.deps.adapter);
    if (!lifecycle || input.marker === undefined) {
      return undefined;
    }

    this.assertNotCancelled(input.signal);
    const result = await lifecycle.waitForNavigationAfter(input.tabId, input.marker, {
      signal: input.signal,
      timeoutMs: this.deps.navigationWaitTimeoutMs ?? POST_NAVIGATION_WAIT_TIMEOUT_MS,
    });

    if (result.status === 'settled') {
      if (result.kind === 'popup') {
        console.log(
          `[interaction] navigation-transition-observed kind=popup causal=${result.causedByAgentInputDispatch}`,
        );
        console.log('[interaction] navigation-settle-completed kind=popup');
      } else {
        console.log(
          `[interaction] navigation-transition-observed kind=${result.kind} generation=${result.generation}`,
        );
        console.log(
          `[interaction] navigation-settle-completed kind=${result.kind} generation=${result.generation}`,
        );
      }
      return result;
    }

    if (result.status === 'timeout') {
      console.log(`[interaction] navigation-transition-timeout started=${result.started}`);
    }

    throw navigationWaitToError(result);
  }

  private async finishAfterPrimitive(input: {
    actionId: string;
    timestamp: number;
    proposal: BoundInteractionProposal;
    stage: ExecutionStageState;
    error: unknown;
    failureStage: InteractionAuditFailureStage;
    treatAsUnknown?: boolean;
  }): Promise<InteractionResult> {
    const pageState = await this.safePageState(input.proposal.tabId);
    const errorCode = mapExecutionError(input.error);
    const unknown =
      input.treatAsUnknown === true && errorCode !== 'REQUEST_CANCELLED';
    const resultStatus: InteractionAuditResultStatus = unknown ? 'execution-state-unknown' : 'failed';
    const reportedStage: InteractionAuditFailureStage = unknown
      ? 'execution-state-unknown'
      : input.failureStage;

    logInteractionDiagnostic(
      unknown ? 'execution-state-unknown' : input.failureStage,
      errorCode,
      input.stage,
    );

    this.appendAudit({
      actionId: input.actionId,
      timestamp: input.timestamp,
      proposal: input.proposal,
      stage: input.stage,
      resultStatus,
      errorCode,
      failureStage: reportedStage,
    });

    return {
      actionId: input.actionId,
      status: unknown ? 'execution-state-unknown' : 'failed',
      pageState,
      errorCode,
    };
  }

  private async dispatchGrantedAction(
    grant: InteractionGrant,
    proposal: BoundInteractionProposal,
    observation: PageObservation,
    policyContext?: ReturnType<InteractionExecutor['buildPolicyContext']>,
  ): Promise<void> {
    assertGrantMatchesProposal(grant, proposal);

    switch (proposal.kind) {
      case 'click':
        await this.deps.adapter.click({
          target: toAdapterTargetRef(policyContext!.resolvedTarget!),
          observedBounds: toObservedBounds(policyContext!.resolvedTarget!.node),
        });
        return;
      case 'type':
        await this.deps.adapter.type({
          target: toAdapterTargetRef(policyContext!.resolvedTarget!),
          text: proposal.text,
          observedBounds: toObservedBounds(policyContext!.resolvedTarget!.node),
        });
        return;
      case 'select':
        await this.deps.adapter.select({
          selectTarget: toAdapterTargetRef(policyContext!.resolvedSelect!),
          optionTarget: toAdapterTargetRef(policyContext!.resolvedOption!),
          selectObservedBounds: toObservedBounds(policyContext!.resolvedSelect!.node),
          optionObservedBounds: toObservedBounds(policyContext!.resolvedOption!.node),
        });
        return;
      case 'scroll':
        if (proposal.mode === 'viewport') {
          await this.deps.adapter.scroll({
            tabId: proposal.tabId,
            documentRevision: proposal.documentRevision,
            direction: proposal.direction,
            amountPx: proposal.amountPx,
            viewportWidth: observation.viewport.width,
            viewportHeight: observation.viewport.height,
          });
          return;
        }

        await this.deps.adapter.scrollIntoView({
          target: toAdapterTargetRef(policyContext!.resolvedTarget!),
          observedBounds: toObservedBounds(policyContext!.resolvedTarget!.node),
          viewport: {
            width: observation.viewport.width,
            height: observation.viewport.height,
            scrollX: observation.viewport.scrollX,
            scrollY: observation.viewport.scrollY,
          },
        });
        return;
    }
  }

  private buildPolicyContext(
    proposal: BoundInteractionProposal,
    observation: PageObservation,
  ): {
    node: ObservationNode;
    optionNode?: ObservationNode;
    resolvedTarget?: ResolvedInteractionTarget;
    resolvedSelect?: ResolvedInteractionTarget;
    resolvedOption?: ResolvedInteractionTarget;
  } | undefined {
    switch (proposal.kind) {
      case 'click':
      case 'type': {
        const resolvedTarget = resolveInteractionTarget({
          bound: proposal,
          targetId: proposal.targetId,
          observation,
          targetRegistry: this.deps.targetRegistry,
        });
        return { node: resolvedTarget.node, resolvedTarget };
      }
      case 'select': {
        const resolvedSelect = resolveInteractionTarget({
          bound: proposal,
          targetId: proposal.targetId,
          observation,
          targetRegistry: this.deps.targetRegistry,
        });
        const resolvedOption = resolveInteractionTarget({
          bound: proposal,
          targetId: proposal.optionTargetId,
          observation,
          targetRegistry: this.deps.targetRegistry,
        });
        return {
          node: resolvedSelect.node,
          optionNode: resolvedOption.node,
          resolvedSelect,
          resolvedOption,
        };
      }
      case 'scroll':
        if (proposal.mode === 'into-view') {
          const resolvedTarget = resolveInteractionTarget({
            bound: proposal,
            targetId: proposal.targetId,
            observation,
            targetRegistry: this.deps.targetRegistry,
          });
          return { node: resolvedTarget.node, resolvedTarget };
        }
        return undefined;
      default:
        return undefined;
    }
  }

  private async finishPolicyDenied(input: {
    actionId: string;
    timestamp: number;
    proposal: BoundInteractionProposal;
    decision: InteractionPolicyDenyDecision;
  }): Promise<InteractionResult> {
    const pageState = await this.safePageState(input.proposal.tabId);

    this.appendAudit({
      actionId: input.actionId,
      timestamp: input.timestamp,
      proposal: input.proposal,
      stage: {
        decision: input.decision,
        adapterPrimitiveInvoked: false,
      },
      resultStatus: 'denied',
      errorCode: input.decision.errorCode,
      failureStage: 'policy',
    });

    logInteractionDiagnostic('policy', input.decision.errorCode, {
      adapterPrimitiveInvoked: false,
      decision: input.decision,
    });

    return {
      actionId: input.actionId,
      status: 'denied',
      pageState,
      errorCode: input.decision.errorCode,
    };
  }

  private async finishExecutionFailed(input: {
    actionId: string;
    timestamp: number;
    proposal: BoundInteractionProposal;
    error?: unknown;
    errorCode?: InteractionResult['errorCode'];
    stage: ExecutionStageState;
    failureStage?: InteractionAuditFailureStage;
  }): Promise<InteractionResult> {
    const pageState = await this.safePageState(input.proposal.tabId);
    const errorCode = input.errorCode ?? mapExecutionError(input.error);

    if (input.failureStage) {
      logInteractionDiagnostic(input.failureStage, errorCode, input.stage);
    }

    this.appendAudit({
      actionId: input.actionId,
      timestamp: input.timestamp,
      proposal: input.proposal,
      stage: input.stage,
      resultStatus: 'failed',
      errorCode,
      failureStage: input.failureStage,
    });

    return {
      actionId: input.actionId,
      status: 'failed',
      pageState,
      errorCode,
    };
  }

  private appendAudit(input: {
    actionId: string;
    timestamp: number;
    proposal: BoundInteractionProposal;
    stage: ExecutionStageState;
    resultStatus: InteractionAuditResultStatus;
    errorCode?: InteractionResult['errorCode'];
    failureStage?: InteractionAuditFailureStage;
    documentRevisionAfter?: string;
  }): void {
    const allowDecision =
      input.stage.decision && isAllowPolicyDecision(input.stage.decision) ? input.stage.decision : undefined;

    this.deps.audit.append(
      buildInteractionAuditEvent({
        actionId: input.actionId,
        timestamp: input.timestamp,
        proposal: input.proposal,
        policyOutcome: input.stage.decision?.outcome,
        grantIssued: input.stage.grant !== undefined,
        grantedAuthority: allowDecision?.authority,
        adapterPrimitiveInvoked: input.stage.adapterPrimitiveInvoked,
        resultStatus: input.resultStatus,
        errorCode: input.errorCode,
        failureStage: input.failureStage,
        documentRevisionAfter: input.documentRevisionAfter,
      }),
    );
  }

  private async safePageState(tabId: string): Promise<PageState> {
    try {
      return await this.deps.adapter.getPageState(tabId);
    } catch {
      return {
        tabId,
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
    }
  }

  private assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new InteractionError('REQUEST_CANCELLED', 'Interaction request was cancelled.');
    }
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const impl = this.deps.sleep ?? defaultSleep;
    await impl(ms, signal);
  }
}

function toAdapterTargetRef(resolved: ResolvedInteractionTarget): AdapterTargetRef {
  return {
    tabId: resolved.tabId,
    frameId: resolved.frameId,
    backendNodeId: resolved.backendNodeId,
    documentRevision: resolved.documentRevision,
  };
}

function toObservedBounds(node: ObservationNode): AdapterObservedBounds | undefined {
  if (!node.bounds) {
    return undefined;
  }

  return {
    x: node.bounds.x,
    y: node.bounds.y,
    width: node.bounds.width,
    height: node.bounds.height,
  };
}

function mapExecutionError(error: unknown): InteractionErrorCode {
  if (error instanceof InteractionError) {
    return error.code;
  }
  if (error instanceof ObservationError) {
    return mapObservationError(error.code);
  }

  return 'INTERACTION_FAILED';
}

function mapObservationError(code: ObservationError['code']): InteractionErrorCode {
  switch (code) {
    case 'PAGE_NOT_READY':
      return 'PAGE_NOT_READY';
    case 'TAB_NOT_FOUND':
      return 'TAB_NOT_FOUND';
    case 'PAGE_CHANGED_DURING_OBSERVATION':
      return 'PAGE_CHANGED_DURING_OBSERVATION';
    case 'OBSERVATION_IN_PROGRESS':
      return 'OBSERVATION_IN_PROGRESS';
    case 'OBSERVATION_FAILED':
    case 'CDP_UNAVAILABLE':
      return 'OBSERVATION_FAILED';
    default:
      return 'INTERACTION_FAILED';
  }
}

function isTransientPostNavigationObservationError(error: unknown): boolean {
  if (error instanceof ObservationError) {
    return (
      error.code === 'PAGE_NOT_READY' ||
      error.code === 'PAGE_CHANGED_DURING_OBSERVATION' ||
      error.code === 'OBSERVATION_IN_PROGRESS' ||
      error.code === 'CDP_UNAVAILABLE'
    );
  }
  if (error instanceof InteractionError) {
    return error.code === 'PAGE_NOT_READY' || error.code === 'PAGE_CHANGED_DURING_OBSERVATION';
  }
  return false;
}

function isNavigationClick(proposal: BoundInteractionProposal, stage: ExecutionStageState): boolean {
  return proposal.kind === 'click' && stage.decision?.outcome === 'ALLOW_NAVIGATE';
}

function causalPopupDestinationTabId(
  wait: NavigationWaitResult | undefined,
  sourceTabId: string,
): string {
  if (
    wait?.status === 'settled' &&
    wait.kind === 'popup' &&
    wait.causedByAgentInputDispatch === true &&
    wait.sourceTabId === sourceTabId &&
    wait.destinationTabId !== sourceTabId &&
    wait.destinationTabId.trim() !== ''
  ) {
    return wait.destinationTabId;
  }
  return sourceTabId;
}

function isTargetResolutionFailure(errorCode: InteractionErrorCode): boolean {
  return (
    errorCode === 'TARGET_STALE' ||
    errorCode === 'TARGET_NOT_FOUND' ||
    errorCode === 'TARGET_NOT_EXPORTED' ||
    errorCode === 'PAGE_CHANGED' ||
    errorCode === 'UNSUPPORTED_FRAME'
  );
}

function logInteractionDiagnostic(
  stage: InteractionAuditFailureStage,
  errorCode: InteractionErrorCode,
  stageState: Pick<ExecutionStageState, 'adapterPrimitiveInvoked' | 'decision'>,
): void {
  const authority =
    stageState.decision && isAllowPolicyDecision(stageState.decision)
      ? stageState.decision.authority
      : 'none';
  console.log(
    `[interaction] ${stage} errorCode=${errorCode} adapterPrimitiveInvoked=${stageState.adapterPrimitiveInvoked} authority=${authority}`,
  );
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new InteractionError('REQUEST_CANCELLED', 'Interaction request was cancelled.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) {
      cleanup();
      reject(new InteractionError('REQUEST_CANCELLED', 'Interaction request was cancelled.'));
      return;
    }
    signal?.addEventListener('abort', onAbort);
  });
}
