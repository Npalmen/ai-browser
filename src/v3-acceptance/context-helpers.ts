import type { InteractiveModelPageContext } from '../ai/interaction-context-builder';
import type { ModelMessage } from '../ai/model-types';
import type { TargetId } from '../shared/observation-types';

export function parseInteractiveContextFromMessages(
  messages: readonly ModelMessage[],
): InteractiveModelPageContext {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'text') {
        continue;
      }
      const start = part.text.indexOf('<UNTRUSTED_PAGE_CONTENT>');
      const end = part.text.indexOf('</UNTRUSTED_PAGE_CONTENT>');
      if (start === -1 || end === -1) {
        continue;
      }
      const inner = part.text.slice(start, end);
      const lines = inner.split('\n');
      const jsonText = lines.slice(3).join('\n').trim();
      return JSON.parse(jsonText) as InteractiveModelPageContext;
    }
  }
  throw new Error('Interactive page context not found in model messages');
}

function isEditableModelNode(
  candidate: InteractiveModelPageContext['nodes'][number],
): boolean {
  if (candidate.secret === true) {
    return false;
  }
  if (candidate.editable === true) {
    return true;
  }
  const role = candidate.role.toLowerCase();
  const tag = candidate.tag?.toLowerCase();
  return (
    candidate.interactive === true &&
    (role === 'textbox' || role === 'searchbox' || tag === 'input' || tag === 'textarea')
  );
}

export function findSecretFieldByName(
  context: InteractiveModelPageContext,
  name: string,
): { targetId: TargetId } {
  const normalized = name.toLowerCase();
  const field = context.nodes.find(
    (candidate) =>
      candidate.targetId &&
      candidate.secret === true &&
      (candidate.name?.toLowerCase().includes(normalized) ?? false),
  );
  if (!field?.targetId) {
    throw new Error(`Secret field not found for name: ${name}`);
  }
  return { targetId: field.targetId };
}

export function findEditableFieldByName(
  context: InteractiveModelPageContext,
  name: string,
): { targetId: TargetId } {
  const normalized = name.toLowerCase();
  const textbox = context.nodes.find((candidate) => {
    if (!candidate.targetId || !isEditableModelNode(candidate)) {
      return false;
    }
    const candidateName = candidate.name?.toLowerCase() ?? '';
    return candidateName.includes(normalized);
  });
  if (textbox?.targetId) {
    return { targetId: textbox.targetId };
  }

  const fallback = context.nodes.find(
    (candidate) => candidate.targetId && isEditableModelNode(candidate),
  );
  if (fallback?.targetId) {
    return { targetId: fallback.targetId };
  }

  throw new Error(`Editable field not found for name: ${name}`);
}

export function findNodeByName(
  context: InteractiveModelPageContext,
  name: string,
): { targetId: TargetId; name?: string } {
  const normalized = name.toLowerCase();
  const node = context.nodes.find((candidate) => {
    const candidateName = candidate.name?.toLowerCase() ?? '';
    const candidateText = candidate.text?.toLowerCase() ?? '';
    return candidateName.includes(normalized) || candidateText.includes(normalized);
  });
  if (!node?.targetId) {
    throw new Error(`Exported node not found for name: ${name}`);
  }
  return { targetId: node.targetId, name: node.name };
}

export function findNativeOption(
  context: InteractiveModelPageContext,
  selectName: string,
  optionName: string,
): { selectTargetId: TargetId; optionTargetId: TargetId } {
  const normalizedSelect = selectName.toLowerCase();
  const selectNode = context.nodes.find((candidate) => {
    const candidateName = candidate.name?.toLowerCase() ?? '';
    return candidateName.includes(normalizedSelect) && candidate.nativeOptions !== undefined;
  });
  if (!selectNode?.targetId || !selectNode.nativeOptions) {
    throw new Error(`Select node not found for name: ${selectName}`);
  }

  const normalizedOption = optionName.toLowerCase();
  const option = selectNode.nativeOptions.find(
    (entry) => entry.name.toLowerCase() === normalizedOption,
  );
  if (!option) {
    throw new Error(`Option not found for select ${selectName}: ${optionName}`);
  }

  return {
    selectTargetId: selectNode.targetId,
    optionTargetId: option.targetId,
  };
}

export function observationContainsText(
  nodes: ReadonlyArray<{ name?: string; text?: string; value?: string }>,
  needle: string,
): boolean {
  const serialized = JSON.stringify(nodes);
  if (serialized.includes(needle)) {
    return true;
  }
  return nodes.some(
    (node) =>
      node.name?.includes(needle) === true ||
      node.text?.includes(needle) === true ||
      node.value?.includes(needle) === true,
  );
}
