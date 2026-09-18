import type { NativeSelectOption, ObservationNode, PageObservation, TargetId } from '../shared/observation-types';
import {
  buildModelPageContext,
  estimateImageTokenSurcharge,
  estimateTextInputTokens,
  MODEL_CONTEXT_BUDGETS,
  type BuildModelPageContextOptions,
  type ModelPageContext,
  type ModelPageNode,
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
}

export interface InteractiveModelPageContext extends ModelPageContext {
  nodes: InteractiveModelPageNode[];
}

export interface BuiltInteractiveModelPageContext {
  context: InteractiveModelPageContext;
  serialized: string;
  exportedTargetIds: ReadonlySet<TargetId>;
}

export function buildInteractiveModelPageContext(
  observation: PageObservation,
  options: BuildModelPageContextOptions = {},
): BuiltInteractiveModelPageContext {
  const maxStructuredChars =
    options.maxStructuredChars ?? MODEL_CONTEXT_BUDGETS.maxStructuredChars;
  const base = buildModelPageContext(observation, options);
  const observationByTargetId = indexObservationNodes(observation.nodes);

  let nodes: InteractiveModelPageNode[] = base.context.nodes.map((node) =>
    enrichNodeWithNativeOptions(
      node,
      node.targetId === undefined ? undefined : observationByTargetId.get(node.targetId),
    ),
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
  if (serialized.length > maxStructuredChars) {
    throw new ModelError(
      'CONTEXT_TOO_LARGE',
      'The interactive page context exceeds the structured export budget.',
    );
  }

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

function indexObservationNodes(nodes: ObservationNode[]): Map<TargetId, ObservationNode> {
  const byTargetId = new Map<TargetId, ObservationNode>();
  for (const node of nodes) {
    if (node.targetId !== undefined) {
      byTargetId.set(node.targetId, node);
    }
  }
  return byTargetId;
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

  if (serializedInteractiveLength(input.document, input.viewport, nodes, truncated) <= input.maxStructuredChars) {
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
      if (serializedInteractiveLength(input.document, input.viewport, nodes, truncated) <= input.maxStructuredChars) {
        return { nodes, truncated };
      }
    }
  }

  return { nodes, truncated };
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

function messagesHaveImage(messages: ModelMessage[]): boolean {
  return messages.some((message) => message.content.some((part) => part.type === 'image'));
}
