import { InteractionError } from '../shared/interaction-errors';
import type { BoundInteractionIdentity } from '../shared/interaction-types';
import type {
  ObservationNode,
  PageObservation,
  TargetId,
} from '../shared/observation-types';
import type { TargetRegistry } from '../observation/target-registry';

export interface ResolvedInteractionTarget {
  tabId: string;
  observationId: string;
  documentRevision: string;
  targetId: TargetId;
  frameId: string;
  backendNodeId: number;
  node: ObservationNode;
}

export interface ResolveInteractionTargetInput {
  bound: BoundInteractionIdentity;
  targetId: TargetId;
  observation: PageObservation;
  targetRegistry: TargetRegistry;
}

export function resolveInteractionTarget(
  input: ResolveInteractionTargetInput,
): ResolvedInteractionTarget {
  const { bound, targetId, observation, targetRegistry } = input;

  assertObservationMatchesBound(observation, bound);

  const record = targetRegistry.resolve(bound.tabId, bound.observationId, targetId);
  if (!record) {
    throw new InteractionError(
      'TARGET_STALE',
      `Target ${targetId} is not valid for the current observation.`,
    );
  }

  if (record.documentRevision !== bound.documentRevision) {
    throw new InteractionError(
      'TARGET_STALE',
      `Target ${targetId} document revision does not match the bound proposal.`,
    );
  }

  const node = observation.nodes.find((candidate) => candidate.targetId === targetId);
  if (!node) {
    throw new InteractionError('TARGET_NOT_FOUND', `Target ${targetId} is missing from the bound observation.`);
  }

  return {
    tabId: bound.tabId,
    observationId: bound.observationId,
    documentRevision: bound.documentRevision,
    targetId,
    frameId: record.frameId,
    backendNodeId: record.backendNodeId,
    node,
  };
}

function assertObservationMatchesBound(
  observation: PageObservation,
  bound: BoundInteractionIdentity,
): void {
  if (observation.tabId !== bound.tabId) {
    throw new InteractionError('TARGET_STALE', 'Observation tab does not match the bound proposal.');
  }

  if (observation.observationId !== bound.observationId) {
    throw new InteractionError('TARGET_STALE', 'Observation id does not match the bound proposal.');
  }

  if (observation.document.revision !== bound.documentRevision) {
    throw new InteractionError('PAGE_CHANGED', 'Observation document revision does not match the bound proposal.');
  }
}
