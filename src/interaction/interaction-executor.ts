import { randomUUID } from 'node:crypto';

import type { BrowserAdapter } from '../browser/browser-adapter';
import type {
  AdapterObservedBounds,
  AdapterTargetRef,
} from '../browser/interaction-adapter-types';
import type { PageState } from '../shared/browser-types';
import { InteractionError } from '../shared/interaction-errors';
import type {
  BoundInteractionProposal,
  InteractionGrant,
  InteractionPolicyAllowDecision,
  InteractionPolicyDenyDecision,
  InteractionResult,
} from '../shared/interaction-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import type { TargetRegistry } from '../observation/target-registry';
import { buildInteractionAuditEvent, type InteractionAuditSink } from './interaction-audit';
import {
  assertGrantMatchesProposal,
  isAllowPolicyDecision,
  issueInteractionGrant,
} from './interaction-grant';
import { classifyInteraction } from './interaction-policy';
import { resolveInteractionTarget, type ResolvedInteractionTarget } from './target-resolver';

export interface InteractionExecutorDependencies {
  adapter: BrowserAdapter;
  targetRegistry: TargetRegistry;
  audit: InteractionAuditSink;
  generateActionId?: () => string;
  now?: () => number;
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

      stage.adapterPrimitiveInvoked = true;
      await this.dispatchGrantedAction(grant, proposal, observation, policyContext);

      try {
        const freshObservation = await this.deps.adapter.observePage(proposal.tabId);
        const pageState = await this.deps.adapter.getPageState(proposal.tabId);

        this.appendAudit({
          actionId,
          timestamp,
          proposal,
          stage,
          resultStatus: 'succeeded',
          documentRevisionAfter: freshObservation.document.revision,
        });

        return {
          actionId,
          status: 'succeeded',
          pageState,
          observation: freshObservation,
        };
      } catch (error: unknown) {
        const pageState = await this.safePageState(proposal.tabId);
        const errorCode = mapExecutionError(error);

        this.appendAudit({
          actionId,
          timestamp,
          proposal,
          stage,
          resultStatus: 'failed',
          errorCode,
        });

        return {
          actionId,
          status: 'failed',
          pageState,
          errorCode,
        };
      }
    } catch (error: unknown) {
      if (stage.adapterPrimitiveInvoked && stage.grant && stage.decision && isAllowPolicyDecision(stage.decision)) {
        const pageState = await this.safePageState(proposal.tabId);
        const errorCode = mapExecutionError(error);

        this.appendAudit({
          actionId,
          timestamp,
          proposal,
          stage,
          resultStatus: 'failed',
          errorCode,
        });

        return {
          actionId,
          status: 'failed',
          pageState,
          errorCode,
        };
      }

      return this.finishExecutionFailed({
        actionId,
        timestamp,
        proposal,
        error,
        stage,
      });
    }
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
          optionCatalogIndex: resolveOptionCatalogIndex(
            policyContext!.resolvedSelect!.node,
            proposal.optionTargetId,
          ),
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
  }): Promise<InteractionResult> {
    const pageState = await this.safePageState(input.proposal.tabId);
    const errorCode = input.errorCode ?? mapExecutionError(input.error);

    this.appendAudit({
      actionId: input.actionId,
      timestamp: input.timestamp,
      proposal: input.proposal,
      stage: input.stage,
      resultStatus: 'failed',
      errorCode,
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
    resultStatus: 'succeeded' | 'failed' | 'denied';
    errorCode?: InteractionResult['errorCode'];
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
}

function resolveOptionCatalogIndex(
  selectNode: ObservationNode,
  optionTargetId: string,
): number {
  const options = selectNode.nativeOptions ?? [];
  const targetIndex = options.findIndex((option) => option.targetId === optionTargetId);
  if (targetIndex < 0) {
    throw new InteractionError('UNSUPPORTED_TARGET', 'Select option is not in the native option catalog.');
  }

  const selectedIndex = options.findIndex((option) => option.selected === true);
  const startIndex = selectedIndex >= 0 ? selectedIndex : 0;
  return targetIndex - startIndex;
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

function mapExecutionError(error: unknown): InteractionResult['errorCode'] {
  if (error instanceof InteractionError) {
    return error.code;
  }

  return 'INTERACTION_FAILED';
}
