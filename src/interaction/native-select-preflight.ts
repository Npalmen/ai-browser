import { InteractionError } from '../shared/interaction-errors';
import type {
  CdpAccessibilityTreeResponse,
  CdpDomSnapshotResponse,
} from '../observation/cdp-types';
import { parseAccessibilityTree, type NormalizedAxNode } from '../observation/ax-parser';
import {
  decodeSnapshotString,
  parseDomSnapshot,
  type NormalizedDomNode,
} from '../observation/dom-snapshot-parser';
import type { FrameId } from '../shared/observation-types';

/** Conservative keyboard traversal bound; aligned with the observation native-option catalog cap. */
export const MAX_NATIVE_SELECT_KEY_STEPS = 50;

export interface NativeSelectPreflightInput {
  selectBackendNodeId: number;
  optionBackendNodeId: number;
  expectedFrameId: FrameId;
  mainFrameId: FrameId;
  accessibilityTree: CdpAccessibilityTreeResponse;
  domSnapshot: CdpDomSnapshotResponse;
}

export interface NativeSelectKeyboardPlan {
  keyboardDelta: number;
  selectBackendNodeId: number;
  optionBackendNodeId: number;
  selectedBackendNodeId: number;
  liveOptionBackendNodeIds: ReadonlyArray<number>;
}

function hasHtmlBooleanAttribute(
  attributes: Record<string, string> | undefined,
  name: string,
): boolean {
  return attributes !== undefined && Object.prototype.hasOwnProperty.call(attributes, name);
}

function decodeDocumentFrameId(
  snapshot: CdpDomSnapshotResponse,
  documentIndex: number,
): FrameId | undefined {
  const rawFrameId = snapshot.documents[documentIndex]?.frameId;
  if (rawFrameId === undefined) {
    return undefined;
  }

  if (typeof rawFrameId === 'string') {
    const trimmed = rawFrameId.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return decodeSnapshotString(snapshot.strings, rawFrameId);
}

function buildDocumentFrameMap(
  snapshot: CdpDomSnapshotResponse,
  mainFrameId: FrameId,
): Map<number, FrameId> {
  const map = new Map<number, FrameId>();
  map.set(0, mainFrameId);

  for (let index = 1; index < snapshot.documents.length; index += 1) {
    const frameId = decodeDocumentFrameId(snapshot, index);
    if (frameId) {
      map.set(index, frameId);
    }
  }

  return map;
}

function parseLiveNodes(input: NativeSelectPreflightInput): {
  domNodes: NormalizedDomNode[];
  axByBackendId: Map<number, NormalizedAxNode>;
} {
  try {
    const parsed = parseDomSnapshot(
      input.domSnapshot,
      buildDocumentFrameMap(input.domSnapshot, input.mainFrameId),
      0,
      0,
    );
    const ax = parseAccessibilityTree(input.accessibilityTree);
    const axByBackendId = new Map<number, NormalizedAxNode>();
    for (const node of ax.nodes) {
      if (node.backendDOMNodeId !== undefined) {
        axByBackendId.set(node.backendDOMNodeId, node);
      }
    }
    return { domNodes: parsed.nodes, axByBackendId };
  } catch {
    throw new InteractionError(
      'UNSUPPORTED_TARGET',
      'Live native select preflight could not parse the current document.',
    );
  }
}

function findDomNode(
  nodes: NormalizedDomNode[],
  backendNodeId: number,
): NormalizedDomNode | undefined {
  return nodes.find((node) => node.backendNodeId === backendNodeId);
}

function optionBelongsToSelect(
  nodesByBackendId: Map<number, NormalizedDomNode>,
  option: NormalizedDomNode,
  selectBackendNodeId: number,
): 'direct' | 'nested' | 'other-select' | 'none' {
  if (option.parentBackendNodeId === selectBackendNodeId) {
    return 'direct';
  }

  let currentParentId = option.parentBackendNodeId;
  const seen = new Set<number>();
  while (currentParentId !== undefined && !seen.has(currentParentId)) {
    seen.add(currentParentId);
    const parent = nodesByBackendId.get(currentParentId);
    if (!parent) {
      break;
    }
    if (parent.tag === 'select') {
      return parent.backendNodeId === selectBackendNodeId ? 'nested' : 'other-select';
    }
    currentParentId = parent.parentBackendNodeId;
  }

  return 'none';
}

function isOptionSelected(
  option: NormalizedDomNode,
  axByBackendId: Map<number, NormalizedAxNode>,
): boolean {
  if (hasHtmlBooleanAttribute(option.attributes, 'selected')) {
    return true;
  }
  return axByBackendId.get(option.backendNodeId)?.selected === true;
}

function isOptionDisabled(
  option: NormalizedDomNode,
  axByBackendId: Map<number, NormalizedAxNode>,
): boolean {
  if (hasHtmlBooleanAttribute(option.attributes, 'disabled')) {
    return true;
  }
  return axByBackendId.get(option.backendNodeId)?.disabled === true;
}

export function deriveNativeSelectKeyboardPlan(
  input: NativeSelectPreflightInput,
): NativeSelectKeyboardPlan {
  if (
    !Number.isInteger(input.selectBackendNodeId) ||
    input.selectBackendNodeId <= 0 ||
    !Number.isInteger(input.optionBackendNodeId) ||
    input.optionBackendNodeId <= 0
  ) {
    throw new InteractionError('UNSUPPORTED_TARGET', 'Native select identities are invalid.');
  }

  const { domNodes, axByBackendId } = parseLiveNodes(input);
  const nodesByBackendId = new Map<number, NormalizedDomNode>();
  for (const node of domNodes) {
    nodesByBackendId.set(node.backendNodeId, node);
  }

  const selectNode = findDomNode(domNodes, input.selectBackendNodeId);
  if (!selectNode) {
    throw new InteractionError('TARGET_NOT_FOUND', 'Native select node is no longer present.');
  }

  if (selectNode.tag !== 'select') {
    throw new InteractionError('UNSUPPORTED_TARGET', 'Target is not a native select element.');
  }

  if (selectNode.frameId !== input.expectedFrameId) {
    throw new InteractionError('UNSUPPORTED_FRAME', 'Native select is not in the expected frame.');
  }

  if (hasHtmlBooleanAttribute(selectNode.attributes, 'multiple')) {
    throw new InteractionError('UNSUPPORTED_TARGET', 'Multiple native selects are not supported.');
  }

  if (isOptionDisabled(selectNode, axByBackendId)) {
    throw new InteractionError('UNSUPPORTED_TARGET', 'Native select is disabled.');
  }

  const hasOptgroup = domNodes.some(
    (node) => node.tag === 'optgroup' && node.parentBackendNodeId === input.selectBackendNodeId,
  );
  if (hasOptgroup) {
    throw new InteractionError(
      'UNSUPPORTED_TARGET',
      'Native select optgroup structures are not supported.',
    );
  }

  const liveOptions = domNodes
    .filter(
      (node) =>
        node.tag === 'option' && node.parentBackendNodeId === input.selectBackendNodeId,
    )
    .sort((left, right) => left.documentOrder - right.documentOrder);

  if (liveOptions.length === 0) {
    throw new InteractionError('UNSUPPORTED_TARGET', 'Native select has no live options.');
  }

  const optionNode = findDomNode(domNodes, input.optionBackendNodeId);
  if (!optionNode) {
    throw new InteractionError('TARGET_NOT_FOUND', 'Granted select option is no longer present.');
  }

  const association = optionBelongsToSelect(nodesByBackendId, optionNode, input.selectBackendNodeId);
  if (association === 'other-select') {
    throw new InteractionError(
      'TARGET_STALE',
      'Granted select option no longer belongs to the granted select.',
    );
  }
  if (association === 'nested') {
    throw new InteractionError(
      'UNSUPPORTED_TARGET',
      'Granted select option is nested in an unsupported select structure.',
    );
  }
  if (association !== 'direct' || optionNode.tag !== 'option') {
    throw new InteractionError(
      'UNSUPPORTED_TARGET',
      'Granted select option cannot be associated by backend identity.',
    );
  }

  if (optionNode.frameId !== input.expectedFrameId) {
    throw new InteractionError('UNSUPPORTED_FRAME', 'Granted select option is not in the expected frame.');
  }

  if (liveOptions.some((option) => isOptionDisabled(option, axByBackendId))) {
    throw new InteractionError(
      'UNSUPPORTED_TARGET',
      'Native select keyboard execution does not support disabled options.',
    );
  }

  const selectedOptions = liveOptions.filter((option) => isOptionSelected(option, axByBackendId));
  if (selectedOptions.length !== 1 || selectedOptions[0] === undefined) {
    throw new InteractionError(
      'UNSUPPORTED_TARGET',
      'Native select does not have a uniquely selected starting option.',
    );
  }

  const selectedOption = selectedOptions[0];
  const selectedIndex = liveOptions.findIndex(
    (option) => option.backendNodeId === selectedOption.backendNodeId,
  );
  const targetIndex = liveOptions.findIndex(
    (option) => option.backendNodeId === input.optionBackendNodeId,
  );

  if (selectedIndex < 0 || targetIndex < 0) {
    throw new InteractionError(
      'UNSUPPORTED_TARGET',
      'Live native select option sequence could not be resolved.',
    );
  }

  const keyboardDelta = targetIndex - selectedIndex;
  if (Math.abs(keyboardDelta) > MAX_NATIVE_SELECT_KEY_STEPS) {
    throw new InteractionError(
      'UNSUPPORTED_TARGET',
      'Native select keyboard traversal exceeds the bounded step limit.',
    );
  }

  return {
    keyboardDelta,
    selectBackendNodeId: input.selectBackendNodeId,
    optionBackendNodeId: input.optionBackendNodeId,
    selectedBackendNodeId: selectedOption.backendNodeId,
    liveOptionBackendNodeIds: liveOptions.map((option) => option.backendNodeId),
  };
}
