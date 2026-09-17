import { randomUUID } from 'node:crypto';

import {
  OBSERVATION_ATTRIBUTE_ALLOWLIST,
  OBSERVATION_BUDGETS,
  type ObservationBudgetConfig,
} from './budgets';
import {
  containsSensitiveValueLiteral,
  isSecretCandidate,
  redactCandidateValue,
} from './redaction';
import type { TargetRecord } from './target-registry';
import type {
  FrameId,
  ObservationId,
  ObservationNode,
  ObservationScreenshot,
  PageObservation,
  TargetId,
} from '../shared/observation-types';
import type { TabId } from '../shared/browser-types';

export const ObservationPriority = {
  VisibleInteractiveInViewport: 1,
  FocusedOrEditable: 2,
  HeadingInViewport: 3,
  VisibleMeaningfulTextInViewport: 4,
  LandmarkInViewport: 5,
  NearViewport: 6,
  StructuralContext: 7,
} as const;

export type ObservationPriorityValue =
  (typeof ObservationPriority)[keyof typeof ObservationPriority];

export interface ObservationCandidate {
  frameId: FrameId;

  role: string;
  name?: string;
  value?: string;
  text?: string;
  tag?: string;

  interactive: boolean;
  visible: boolean;
  inViewport: boolean;

  focused?: boolean;
  editable?: boolean;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;

  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  attributes?: Record<string, string>;

  targetIdentity?: {
    backendNodeId: number;
    axNodeId?: string;
  };

  priority: ObservationPriorityValue;
  documentOrder: number;
}

export interface BuildObservationInput {
  observationId: ObservationId;
  tabId: TabId;
  capturedAt: number;

  document: PageObservation['document'];
  viewport: PageObservation['viewport'];

  candidates: ObservationCandidate[];

  sourceStats: {
    sourceAxNodeCount: number;
    sourceDomNodeCount: number;
    frameCount: number;
    crossOriginFrameCount: number;
  };

  screenshot?: ObservationScreenshot;
  externallyTruncated?: boolean;
  budgets?: Partial<ObservationBudgetConfig>;
}

export interface BuiltObservation {
  observation: PageObservation;
  targets: TargetRecord[];
}

interface PreparedCandidate {
  candidate: ObservationCandidate;
  priority: ObservationPriorityValue;
  documentOrder: number;
  name?: string;
  value?: string;
  text?: string;
  secret: boolean;
  redacted: boolean;
  attributes?: Record<string, string>;
}

function resolveBudgets(budgets?: Partial<ObservationBudgetConfig>): ObservationBudgetConfig {
  return {
    ...OBSERVATION_BUDGETS,
    ...budgets,
  };
}

function trimOptionalText(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateText(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) {
    return { text: value, truncated: false };
  }

  return { text: value.slice(0, limit), truncated: true };
}

function textLength(fields: { name?: string; value?: string; text?: string }): number {
  return (fields.name?.length ?? 0) + (fields.value?.length ?? 0) + (fields.text?.length ?? 0);
}

function filterAttributes(
  attributes: Record<string, string> | undefined,
  budgets: ObservationBudgetConfig,
): { attributes?: Record<string, string>; truncated: boolean } {
  if (!attributes) {
    return { attributes: undefined, truncated: false };
  }

  let truncated = false;
  const filtered: Record<string, string> = {};

  for (const key of OBSERVATION_ATTRIBUTE_ALLOWLIST) {
    const rawValue = attributes[key];
    if (rawValue === undefined) {
      continue;
    }

    if (Object.keys(filtered).length >= budgets.maxAttributesPerNode) {
      truncated = true;
      break;
    }

    const { text, truncated: valueTruncated } = truncateText(
      rawValue,
      budgets.maxAttributeValueChars,
    );
    filtered[key] = text;
    if (valueTruncated) {
      truncated = true;
    }
  }

  for (const key of OBSERVATION_ATTRIBUTE_ALLOWLIST) {
    if (attributes[key] !== undefined && !(key in filtered)) {
      truncated = true;
      break;
    }
  }

  const droppedDisallowed = Object.keys(attributes).some(
    (key) => !OBSERVATION_ATTRIBUTE_ALLOWLIST.includes(key as (typeof OBSERVATION_ATTRIBUTE_ALLOWLIST)[number]),
  );
  if (droppedDisallowed) {
    truncated = true;
  }

  return {
    attributes: Object.keys(filtered).length > 0 ? filtered : undefined,
    truncated,
  };
}

function prepareCandidate(
  candidate: ObservationCandidate,
  budgets: ObservationBudgetConfig,
): { prepared: PreparedCandidate; truncated: boolean } {
  const redactionInput = {
    tag: candidate.tag,
    role: candidate.role,
    name: candidate.name,
    value: candidate.value,
    attributes: candidate.attributes,
  };
  const redaction = redactCandidateValue(redactionInput);
  let secret = redaction.secret || isSecretCandidate(redactionInput);

  let truncated = false;
  let textRedacted = false;
  let nameRedacted = false;

  let name = trimOptionalText(candidate.name);
  let text = trimOptionalText(candidate.text);
  let value = trimOptionalText(redaction.value);

  if (name && containsSensitiveValueLiteral(name)) {
    secret = true;
    name = undefined;
    nameRedacted = true;
  }

  if (text && (secret || containsSensitiveValueLiteral(text))) {
    secret = true;
    text = undefined;
    textRedacted = true;
  }

  if (value && containsSensitiveValueLiteral(value)) {
    secret = true;
    value = undefined;
    textRedacted = true;
  }

  let preparedName: string | undefined;
  let preparedText: string | undefined;
  let preparedValue: string | undefined;

  if (name) {
    const result = truncateText(name, budgets.maxTextCharsPerNode);
    preparedName = result.text;
    truncated ||= result.truncated;
  }

  if (text) {
    const result = truncateText(text, budgets.maxTextCharsPerNode);
    preparedText = result.text;
    truncated ||= result.truncated;
  }

  if (value) {
    const result = truncateText(value, budgets.maxTextCharsPerNode);
    preparedValue = result.text;
    truncated ||= result.truncated;
  }

  const attributeResult = filterAttributes(candidate.attributes, budgets);
  truncated ||= attributeResult.truncated;

  return {
    prepared: {
      candidate,
      priority: candidate.priority,
      documentOrder: candidate.documentOrder,
      name: preparedName,
      value: preparedValue,
      text: preparedText,
      secret,
      redacted: redaction.redacted || textRedacted || nameRedacted,
      attributes: attributeResult.attributes,
    },
    truncated,
  };
}

function applyTotalTextBudget(
  preparedCandidates: PreparedCandidate[],
  budgets: ObservationBudgetConfig,
): boolean {
  let truncated = false;

  const byLowestPriority = [...preparedCandidates].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return right.documentOrder - left.documentOrder;
  });

  while (textLengthTotals(preparedCandidates) > budgets.maxTotalTextChars) {
    let reduced = false;

    for (const item of byLowestPriority) {
      if (textLengthTotals(preparedCandidates) <= budgets.maxTotalTextChars) {
        break;
      }

      if (item.text) {
        item.text = undefined;
        truncated = true;
        reduced = true;
        continue;
      }

      if (item.value) {
        item.value = undefined;
        truncated = true;
        reduced = true;
        continue;
      }

      if (item.name) {
        item.name = undefined;
        truncated = true;
        reduced = true;
      }
    }

    if (!reduced) {
      break;
    }
  }

  return truncated;
}

function textLengthTotals(items: PreparedCandidate[]): number {
  return items.reduce((total, item) => total + textLength(item), 0);
}

function buildStates(prepared: PreparedCandidate): ObservationNode['states'] {
  const states: NonNullable<ObservationNode['states']> = {};

  if (prepared.candidate.disabled) {
    states.disabled = true;
  }
  if (prepared.candidate.focused) {
    states.focused = true;
  }
  if (prepared.candidate.checked !== undefined) {
    states.checked = prepared.candidate.checked;
  }
  if (prepared.candidate.selected) {
    states.selected = true;
  }
  if (prepared.candidate.expanded) {
    states.expanded = true;
  }
  if (prepared.candidate.editable) {
    states.editable = true;
  }
  if (prepared.secret) {
    states.secret = true;
  }

  return Object.keys(states).length > 0 ? states : undefined;
}

export function buildObservation(input: BuildObservationInput): BuiltObservation {
  const budgets = resolveBudgets(input.budgets);
  let truncated = input.externallyTruncated ?? false;
  let redactedValueCount = 0;

  const prepared = input.candidates.map((candidate) => {
    const result = prepareCandidate(candidate, budgets);
    if (result.truncated) {
      truncated = true;
    }
    if (result.prepared.redacted) {
      redactedValueCount += 1;
    }
    return result.prepared;
  });

  const selected = [...prepared]
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.documentOrder - right.documentOrder;
    })
    .slice(0, budgets.maxEmittedNodes);

  if (prepared.length > selected.length) {
    truncated = true;
  }

  const survivors = selected.sort((left, right) => left.documentOrder - right.documentOrder);

  if (applyTotalTextBudget(survivors, budgets)) {
    truncated = true;
  }

  const targets: TargetRecord[] = [];
  const nodes: ObservationNode[] = survivors.map((item) => {
    let targetId: TargetId | undefined;
    const backendNodeId = item.candidate.targetIdentity?.backendNodeId;

    if (backendNodeId !== undefined) {
      targetId = randomUUID();
      targets.push({
        targetId,
        tabId: input.tabId,
        observationId: input.observationId,
        documentRevision: input.document.revision,
        frameId: item.candidate.frameId,
        backendNodeId,
        axNodeId: item.candidate.targetIdentity?.axNodeId,
      });
    }

    const node: ObservationNode = {
      frameId: item.candidate.frameId,
      role: item.candidate.role,
      interactive: item.candidate.interactive,
      visible: item.candidate.visible,
      inViewport: item.candidate.inViewport,
    };

    if (targetId) {
      node.targetId = targetId;
    }
    if (item.name) {
      node.name = item.name;
    }
    if (item.value) {
      node.value = item.value;
    }
    if (item.text) {
      node.text = item.text;
    }
    if (item.candidate.tag) {
      node.tag = item.candidate.tag;
    }

    const states = buildStates(item);
    if (states) {
      node.states = states;
    }
    if (item.candidate.bounds) {
      node.bounds = item.candidate.bounds;
    }
    if (item.attributes) {
      node.attributes = item.attributes;
    }

    return node;
  });

  const observation: PageObservation = {
    observationId: input.observationId,
    tabId: input.tabId,
    capturedAt: input.capturedAt,
    document: input.document,
    viewport: input.viewport,
    nodes,
    stats: {
      sourceAxNodeCount: input.sourceStats.sourceAxNodeCount,
      sourceDomNodeCount: input.sourceStats.sourceDomNodeCount,
      emittedNodeCount: nodes.length,
      truncated,
      redactedValueCount,
      frameCount: input.sourceStats.frameCount,
      crossOriginFrameCount: input.sourceStats.crossOriginFrameCount,
    },
  };

  if (input.screenshot) {
    observation.screenshot = input.screenshot;
  }

  return { observation, targets };
}
