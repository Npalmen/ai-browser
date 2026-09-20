import type { ObservationNode, PageObservation, TargetId } from '../shared/observation-types';
import {
  buildModelPageContext,
  clipModelPageNodeFields,
  estimateImageTokenSurcharge,
  estimateModelPageContextLength,
  estimateTextInputTokens,
  modelPageNodeExportPriority,
  MODEL_CONTEXT_BUDGETS,
  type BuildModelPageContextOptions,
  type ModelPageContext,
  type ModelPageNode,
  type PageContextBuildDiagnostics,
  normalizeUserQuestion,
  wrapUntrustedPageContent,
} from './context-builder';
import type { ModelMessage } from './model-types';
import type { ModelExportDecision } from './export-policy';
import { ModelError } from './model-errors';
import { INTERACTION_SYSTEM_PROMPT } from './interaction-system-prompt';

export interface InteractiveModelNativeOption {
  targetId: TargetId;
  name: string;
  selected?: true;
}

export interface InteractiveModelPageNode extends ModelPageNode {
  nativeOptions?: InteractiveModelNativeOption[];
  href?: string;
}

export interface InteractiveModelPageContext extends ModelPageContext {
  nodes: InteractiveModelPageNode[];
}

export interface BuiltInteractiveModelPageContext {
  context: InteractiveModelPageContext;
  serialized: string;
  exportedTargetIds: ReadonlySet<TargetId>;
}

export interface InteractivePageContextBuildDiagnostics extends PageContextBuildDiagnostics {
  readonly charsAfterInteractiveEnrichment: number;
  readonly exportedLinkCount: number;
  readonly totalHrefChars: number;
}

export interface BuildInteractiveModelPageContextOptions extends Omit<
  BuildModelPageContextOptions,
  'collectDiagnostics'
> {
  collectDiagnostics?: (diagnostics: InteractivePageContextBuildDiagnostics) => void;
}

const UNSUPPORTED_EXPORTED_HREF_SCHEMES = /^(javascript|data|file|mailto|tel|blob|about):/i;
export const MAX_EXPORTED_HREF_CHARS = 120;
const FIELD_CLIP_LIMITS = [120, 80, 40, 20] as const;

export function buildInteractiveModelPageContext(
  observation: PageObservation,
  options: BuildInteractiveModelPageContextOptions = {},
): BuiltInteractiveModelPageContext {
  const maxStructuredChars =
    options.maxStructuredChars ?? MODEL_CONTEXT_BUDGETS.maxStructuredChars;
  let baseDiagnostics: PageContextBuildDiagnostics | undefined;
  const base = buildModelPageContext(observation, {
    ...options,
    collectDiagnostics: (diagnostics) => {
      baseDiagnostics = diagnostics;
    },
  });
  const observationByTargetId = indexObservationNodes(observation.nodes);

  let nodes: InteractiveModelPageNode[] = base.context.nodes.map((node) =>
    enrichInteractiveNode(
      node,
      node.targetId === undefined ? undefined : observationByTargetId.get(node.targetId),
    ),
  );

  const charsAfterInteractiveEnrichment = serializedInteractiveLength(
    base.context.document,
    base.context.viewport,
    nodes,
    base.context.truncated,
  );

  let truncated = base.context.truncated;
  ({ nodes, truncated } = fitInteractiveNodesWithinBudget({
    document: base.context.document,
    viewport: base.context.viewport,
    nodes,
    maxStructuredChars,
    truncated,
  }));

  const context: InteractiveModelPageContext = {
    document: base.context.document,
    ...(base.context.viewport === undefined ? {} : { viewport: base.context.viewport }),
    truncated,
    nodes,
  };
  const serialized = JSON.stringify(context);
  const hrefStats = countHrefStats(nodes);
  if (serialized.length > maxStructuredChars) {
    options.collectDiagnostics?.({
      sourceNodeCount: baseDiagnostics?.sourceNodeCount ?? observation.nodes.length,
      selectedNodeCount: nodes.length,
      charsBeforeCompaction:
        baseDiagnostics?.charsBeforeCompaction ??
        estimateModelPageContextLength(
          base.context.document,
          base.context.viewport,
          observation.nodes.map((node) => compactObservationNodeForMeasure(node)),
          false,
        ),
      charsAfterCompaction: baseDiagnostics?.charsAfterCompaction ?? base.serialized.length,
      charsAfterInteractiveEnrichment,
      exportedLinkCount: hrefStats.exportedLinkCount,
      totalHrefChars: hrefStats.totalHrefChars,
      truncated,
      overflowStage: 'interactive-enrichment',
    });
    throw new ModelError(
      'CONTEXT_TOO_LARGE',
      'The interactive page context exceeds the structured export budget.',
    );
  }

  options.collectDiagnostics?.({
    sourceNodeCount: baseDiagnostics?.sourceNodeCount ?? observation.nodes.length,
    selectedNodeCount: nodes.length,
    charsBeforeCompaction: baseDiagnostics?.charsBeforeCompaction ?? 0,
    charsAfterCompaction: baseDiagnostics?.charsAfterCompaction ?? base.serialized.length,
    charsAfterInteractiveEnrichment: serialized.length,
    exportedLinkCount: hrefStats.exportedLinkCount,
    totalHrefChars: hrefStats.totalHrefChars,
    truncated,
    overflowStage: 'none',
  });

  return {
    context,
    serialized,
    exportedTargetIds: collectExportedTargetIds(nodes),
  };
}

export function buildInteractiveModelMessages(input: {
  instruction: string;
  serializedPageContext: string;
  exportDecision: ModelExportDecision;
  screenshot?: { mimeType: 'image/jpeg'; data: string };
  priorConversation?: string;
  trustedProgress?: string;
}): ModelMessage[] {
  if (!input.exportDecision.structuredExportAllowed) {
    throw new ModelError(
      'MODEL_NOT_CONFIGURED',
      'Remote structured page export is not allowed.',
    );
  }

  const instruction = normalizeUserQuestion(input.instruction);
  const untrustedText = wrapUntrustedPageContent(input.serializedPageContext);
  const pageContent: ModelMessage['content'] = [{ type: 'text', text: untrustedText }];

  if (input.exportDecision.screenshotExportAllowed && input.screenshot) {
    pageContent.push({
      type: 'image',
      mimeType: 'image/jpeg',
      dataBase64: input.screenshot.data,
    });
  }

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: [{ type: 'text', text: INTERACTION_SYSTEM_PROMPT }],
    },
  ];

  if (input.trustedProgress) {
    messages.push({
      role: 'system',
      content: [{ type: 'text', text: input.trustedProgress }],
    });
  }

  if (input.priorConversation) {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: input.priorConversation }],
    });
  }

  messages.push(
    {
      role: 'user',
      content: [{ type: 'text', text: instruction }],
    },
    {
      role: 'user',
      content: pageContent,
    },
  );

  return messages;
}

export function estimateInteractiveModelInputTokens(messages: ModelMessage[]): number {
  return (
    estimateTextInputTokens(messages) +
    estimateImageTokenSurcharge(messagesHaveImage(messages))
  );
}

export function compactModelFacingHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  let summary = trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const path =
        url.pathname.length > 80 ? `${url.pathname.slice(0, 77)}...` : url.pathname;
      summary = `${url.origin}${path}`;
    } else {
      summary = url.origin || trimmed.split('?')[0]?.split('#')[0] || trimmed;
    }
  } catch {
    summary = trimmed.split('?')[0]?.split('#')[0] || trimmed;
  }

  if (summary.length > MAX_EXPORTED_HREF_CHARS) {
    return `${summary.slice(0, MAX_EXPORTED_HREF_CHARS - 3)}...`;
  }
  return summary;
}

function indexObservationNodes(nodes: ObservationNode[]): Map<TargetId, ObservationNode> {
  const byTargetId = new Map<TargetId, ObservationNode>();
  for (const node of nodes) {
    if (node.targetId !== undefined) {
      byTargetId.set(node.targetId, node);
    }
  }
  return byTargetId;
}

function enrichInteractiveNode(
  node: ModelPageNode,
  observationNode?: ObservationNode,
): InteractiveModelPageNode {
  const withOptions = enrichNodeWithNativeOptions(node, observationNode);
  const href = safeExportedHref(observationNode);
  if (!href) {
    return withOptions;
  }
  return { ...withOptions, href };
}

function safeExportedHref(node?: ObservationNode): string | undefined {
  if (!node) {
    return undefined;
  }
  const role = node.role.toLowerCase();
  if (node.tag !== 'a' && role !== 'link') {
    return undefined;
  }
  const href = node.attributes?.href?.trim();
  if (!href || UNSUPPORTED_EXPORTED_HREF_SCHEMES.test(href)) {
    return undefined;
  }
  return compactModelFacingHref(href);
}

function enrichNodeWithNativeOptions(
  node: ModelPageNode,
  observationNode?: ObservationNode,
): InteractiveModelPageNode {
  if (!node.targetId || observationNode?.tag !== 'select' || !observationNode.nativeOptions?.length) {
    return node;
  }

  return {
    ...node,
    nativeOptions: observationNode.nativeOptions.map((option) => ({
      targetId: option.targetId,
      name: option.name,
      ...(option.selected ? { selected: true as const } : {}),
    })),
  };
}

function fitInteractiveNodesWithinBudget(input: {
  document: ModelPageContext['document'];
  viewport: ModelPageContext['viewport'];
  nodes: InteractiveModelPageNode[];
  maxStructuredChars: number;
  truncated: boolean;
}): { nodes: InteractiveModelPageNode[]; truncated: boolean } {
  let nodes = input.nodes;
  let truncated = input.truncated;

  const measure = () =>
    serializedInteractiveLength(input.document, input.viewport, nodes, truncated);

  if (measure() <= input.maxStructuredChars) {
    return { nodes, truncated };
  }

  const selectIndexes = nodes
    .map((node, index) => ({ node, index }))
    .filter((item) => item.node.nativeOptions && item.node.nativeOptions.length > 0);

  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = selectIndexes.length - 1; i >= 0; i -= 1) {
      const { index } = selectIndexes[i];
      const current = nodes[index];
      if (!current?.nativeOptions || current.nativeOptions.length === 0) {
        continue;
      }

      if (pass === 0) {
        nodes = nodes.map((node, nodeIndex) =>
          nodeIndex === index
            ? { ...node, nativeOptions: node.nativeOptions?.slice(0, -1) }
            : node,
        );
        const nextOptions = nodes[index]?.nativeOptions;
        if (nextOptions && nextOptions.length === 0) {
          nodes = nodes.map((node, nodeIndex) =>
            nodeIndex === index ? { ...node, nativeOptions: undefined } : node,
          );
        }
      } else {
        nodes = nodes.map((node, nodeIndex) =>
          nodeIndex === index ? { ...node, nativeOptions: undefined } : node,
        );
      }

      truncated = true;
      if (measure() <= input.maxStructuredChars) {
        return { nodes, truncated };
      }
    }
  }

  nodes = nodes.map((node) =>
    node.href === undefined ? node : { ...node, href: compactModelFacingHref(node.href) },
  );
  if (measure() <= input.maxStructuredChars) {
    return { nodes, truncated: true };
  }

  const hrefIndexes = nodes
    .map((node, index) => ({ node, index }))
    .filter((item) => item.node.href !== undefined)
    .sort((left, right) => {
      const priorityDelta =
        modelPageNodeExportPriority(right.node) - modelPageNodeExportPriority(left.node);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return right.index - left.index;
    });

  for (const { index } of hrefIndexes) {
    if (measure() <= input.maxStructuredChars) {
      break;
    }
    nodes = nodes.map((node, nodeIndex) =>
      nodeIndex === index ? { ...node, href: undefined } : node,
    );
    truncated = true;
  }
  if (measure() <= input.maxStructuredChars) {
    return { nodes, truncated };
  }

  for (const limit of FIELD_CLIP_LIMITS) {
    for (const { index } of interactiveClipOrder(nodes)) {
      nodes[index] = clipModelPageNodeFields(nodes[index], limit, { omitBounds: limit <= 40 });
      truncated = true;
      if (measure() <= input.maxStructuredChars) {
        return { nodes, truncated };
      }
    }
  }

  while (nodes.length > 0 && measure() > input.maxStructuredChars) {
    const dropIndex = selectLowestPriorityInteractiveNodeIndex(nodes);
    if (dropIndex === undefined) {
      break;
    }
    nodes = nodes.filter((_, index) => index !== dropIndex);
    truncated = true;
  }

  return { nodes, truncated };
}

function interactiveClipOrder(
  nodes: InteractiveModelPageNode[],
): Array<{ node: InteractiveModelPageNode; index: number }> {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const priorityDelta =
        modelPageNodeExportPriority(right.node) - modelPageNodeExportPriority(left.node);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return right.index - left.index;
    });
}

function selectLowestPriorityInteractiveNodeIndex(
  nodes: InteractiveModelPageNode[],
): number | undefined {
  if (nodes.length === 0) {
    return undefined;
  }
  let dropIndex = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const current = nodes[index];
    const lowest = nodes[dropIndex];
    const currentPriority = modelPageNodeExportPriority(current);
    const lowestPriority = modelPageNodeExportPriority(lowest);
    if (currentPriority > lowestPriority) {
      dropIndex = index;
      continue;
    }
    if (currentPriority === lowestPriority && index > dropIndex) {
      dropIndex = index;
    }
  }
  return dropIndex;
}

function serializedInteractiveLength(
  document: ModelPageContext['document'],
  viewport: ModelPageContext['viewport'],
  nodes: InteractiveModelPageNode[],
  truncated: boolean,
): number {
  return JSON.stringify({
    document,
    ...(viewport === undefined ? {} : { viewport }),
    truncated,
    nodes,
  }).length;
}

function collectExportedTargetIds(nodes: InteractiveModelPageNode[]): ReadonlySet<TargetId> {
  const ids = new Set<TargetId>();
  for (const node of nodes) {
    if (node.targetId !== undefined) {
      ids.add(node.targetId);
    }
    if (node.nativeOptions) {
      for (const option of node.nativeOptions) {
        ids.add(option.targetId);
      }
    }
  }
  return ids;
}

function countHrefStats(nodes: readonly InteractiveModelPageNode[]): {
  exportedLinkCount: number;
  totalHrefChars: number;
} {
  let exportedLinkCount = 0;
  let totalHrefChars = 0;
  for (const node of nodes) {
    if (node.href === undefined) {
      continue;
    }
    exportedLinkCount += 1;
    totalHrefChars += node.href.length;
  }
  return { exportedLinkCount, totalHrefChars };
}

function compactObservationNodeForMeasure(node: ObservationNode): ModelPageNode {
  return { role: node.role };
}

function messagesHaveImage(messages: ModelMessage[]): boolean {
  return messages.some((message) => message.content.some((part) => part.type === 'image'));
}
