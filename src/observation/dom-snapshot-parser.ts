import { ObservationError } from '../shared/observation-types';
import type {
  CdpDomSnapshotDocument,
  CdpDomSnapshotNodes,
  CdpDomSnapshotResponse,
} from './cdp-types';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export interface NormalizedDomNode {
  backendNodeId: number;
  parentBackendNodeId?: number;
  frameId: string;
  nodeType: number;
  tag?: string;
  text?: string;
  attributes: Record<string, string>;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  display?: string;
  visibility?: string;
  opacity?: number;
  documentOrder: number;
  contentDocumentIndex?: number;
}

export interface ParsedDomSnapshot {
  nodes: NormalizedDomNode[];
  domNodeCount: number;
}

export function decodeSnapshotString(strings: string[], index: number | undefined): string | undefined {
  if (index === undefined || index < 0 || index >= strings.length) {
    return undefined;
  }

  return strings[index];
}

function decodeRareString(
  strings: string[],
  nodes: CdpDomSnapshotNodes,
  field: 'textValue' | 'inputValue',
  nodeIndex: number,
): string | undefined {
  const rare = nodes[field];
  if (!rare?.index || !rare.value) {
    return undefined;
  }

  const position = rare.index.indexOf(nodeIndex);
  if (position === -1) {
    return undefined;
  }

  return decodeSnapshotString(strings, rare.value[position]);
}

function decodeRareNumber(
  nodes: CdpDomSnapshotNodes,
  field: 'contentDocumentIndex',
  nodeIndex: number,
): number | undefined {
  const rare = nodes[field];
  if (!rare?.index || !rare.value) {
    return undefined;
  }

  const position = rare.index.indexOf(nodeIndex);
  if (position === -1) {
    return undefined;
  }

  const value = rare.value[position];
  return Number.isFinite(value) ? value : undefined;
}

function extractLayoutBounds(
  bounds: number[] | number[][] | undefined,
  layoutIndex: number,
): number[] | undefined {
  if (!bounds || bounds.length === 0) {
    return undefined;
  }

  if (Array.isArray(bounds[0])) {
    const rect = (bounds as number[][])[layoutIndex];
    return Array.isArray(rect) && rect.length >= 4 ? rect.slice(0, 4) : undefined;
  }

  const rect = (bounds as number[]).slice(layoutIndex * 4, layoutIndex * 4 + 4);
  return rect.length === 4 ? rect : undefined;
}

function buildLayoutIndex(
  strings: string[],
  document: CdpDomSnapshotDocument,
  computedStyleCount: number,
): Map<number, { bounds?: number[]; display?: string; visibility?: string; opacity?: number }> {
  const layoutByNodeIndex = new Map<
    number,
    { bounds?: number[]; display?: string; visibility?: string; opacity?: number }
  >();

  const layout = document.layout;
  const nodeIndexes = layout.nodeIndex ?? [];
  const bounds = layout.bounds ?? [];
  const styles = layout.styles ?? [];

  for (let layoutIndex = 0; layoutIndex < nodeIndexes.length; layoutIndex += 1) {
    const nodeIndex = nodeIndexes[layoutIndex];
    const styleStart = layoutIndex * computedStyleCount;
    const styleValues = styles.slice(styleStart, styleStart + computedStyleCount);

    layoutByNodeIndex.set(nodeIndex, {
      bounds: extractLayoutBounds(bounds, layoutIndex),
      display: decodeSnapshotString(strings, styleValues[0]),
      visibility: decodeSnapshotString(strings, styleValues[1]),
      opacity: parseOpacity(decodeSnapshotString(strings, styleValues[2])),
    });
  }

  return layoutByNodeIndex;
}

function parseOpacity(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildFlatAttributeMap(
  strings: string[],
  nodes: CdpDomSnapshotNodes,
): Map<number, Record<string, string>> {
  const attributeMap = new Map<number, Record<string, string>>();
  const rawAttributes = nodes.attributes;
  if (!rawAttributes || rawAttributes.length === 0 || Array.isArray(rawAttributes[0])) {
    return attributeMap;
  }

  const flatAttributes = rawAttributes as number[];
  const attributeIndex = nodes.attributeIndex;
  if (!attributeIndex?.index || !attributeIndex.value) {
    return attributeMap;
  }

  let cursor = 0;
  for (let entry = 0; entry < attributeIndex.index.length; entry += 1) {
    const nodeIndex = attributeIndex.index[entry];
    const pairCount = attributeIndex.value[entry];
    const attributes: Record<string, string> = {};

    for (let pair = 0; pair < pairCount; pair += 1) {
      const name = decodeSnapshotString(strings, flatAttributes[cursor]);
      const value = decodeSnapshotString(strings, flatAttributes[cursor + 1]);
      cursor += 2;
      if (name) {
        attributes[name.toLowerCase()] = value ?? '';
      }
    }

    attributeMap.set(nodeIndex, attributes);
  }

  return attributeMap;
}

function toViewportBounds(
  bounds: number[],
  scrollX: number,
  scrollY: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: bounds[0] - scrollX,
    y: bounds[1] - scrollY,
    width: bounds[2],
    height: bounds[3],
  };
}

export function parseDomSnapshotDocument(
  snapshot: CdpDomSnapshotResponse,
  document: CdpDomSnapshotDocument,
  frameId: string,
  scrollX: number,
  scrollY: number,
  documentOrderStart: number,
): { nodes: NormalizedDomNode[]; nextDocumentOrder: number } {
  if (!snapshot.strings || !document.nodes || !document.layout) {
    throw new ObservationError('OBSERVATION_FAILED', 'DOM snapshot document is malformed');
  }

  const computedStyleCount = 3;
  const layoutByNodeIndex = buildLayoutIndex(snapshot.strings, document, computedStyleCount);
  const nodes = document.nodes;
  const nodeCount = nodes.backendNodeId?.length ?? 0;
  const parsed: NormalizedDomNode[] = [];
  let documentOrder = documentOrderStart;
  const flatAttributeMap = buildFlatAttributeMap(snapshot.strings, nodes);

  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const backendNodeId = nodes.backendNodeId?.[nodeIndex];
    if (backendNodeId === undefined) {
      throw new ObservationError('OBSERVATION_FAILED', 'DOM snapshot node is missing backendNodeId');
    }

    const parentIndex = nodes.parentIndex?.[nodeIndex];
    const parentBackendNodeId =
      parentIndex !== undefined && parentIndex >= 0
        ? nodes.backendNodeId?.[parentIndex]
        : undefined;

    const nodeType = nodes.nodeType?.[nodeIndex] ?? 0;
    const tag = decodeSnapshotString(snapshot.strings, nodes.nodeName?.[nodeIndex])?.toLowerCase();
    const nodeValue = decodeSnapshotString(snapshot.strings, nodes.nodeValue?.[nodeIndex]);
    const textValue = decodeRareString(snapshot.strings, nodes, 'textValue', nodeIndex);
    const inputValue = decodeRareString(snapshot.strings, nodes, 'inputValue', nodeIndex);
    const contentDocumentIndex = decodeRareNumber(nodes, 'contentDocumentIndex', nodeIndex);

    let attributes: Record<string, string> = flatAttributeMap.get(nodeIndex) ?? {};
    const rawAttributes = nodes.attributes;
    if (rawAttributes && Array.isArray(rawAttributes[0])) {
      const nodeAttributeIndexes = (rawAttributes as number[][])[nodeIndex];
      attributes = {};
      if (nodeAttributeIndexes) {
        for (
          let attributeIndex = 0;
          attributeIndex < nodeAttributeIndexes.length;
          attributeIndex += 2
        ) {
          const name = decodeSnapshotString(snapshot.strings, nodeAttributeIndexes[attributeIndex]);
          const value = decodeSnapshotString(
            snapshot.strings,
            nodeAttributeIndexes[attributeIndex + 1],
          );
          if (name) {
            attributes[name.toLowerCase()] = value ?? '';
          }
        }
      }
    }

    const layout = layoutByNodeIndex.get(nodeIndex);
    const bounds =
      layout?.bounds && layout.bounds.length === 4
        ? toViewportBounds(layout.bounds, scrollX, scrollY)
        : undefined;

    const text =
      nodeType === TEXT_NODE
        ? (textValue ?? nodeValue)?.trim()
        : textValue?.trim() ?? inputValue?.trim();

    parsed.push({
      backendNodeId,
      parentBackendNodeId,
      frameId,
      nodeType,
      tag: nodeType === ELEMENT_NODE ? tag : undefined,
      text: text && text.length > 0 ? text : undefined,
      attributes,
      bounds,
      display: layout?.display,
      visibility: layout?.visibility,
      opacity: layout?.opacity,
      documentOrder: documentOrder++,
      contentDocumentIndex,
    });
  }

  return { nodes: parsed, nextDocumentOrder: documentOrder };
}

export function parseDomSnapshot(
  snapshot: CdpDomSnapshotResponse,
  frameIdByDocumentIndex: Map<number, string>,
  scrollX: number,
  scrollY: number,
): ParsedDomSnapshot {
  if (!snapshot.documents || snapshot.documents.length === 0) {
    return { nodes: [], domNodeCount: 0 };
  }

  const allNodes: NormalizedDomNode[] = [];
  let documentOrder = 0;

  for (let documentIndex = 0; documentIndex < snapshot.documents.length; documentIndex += 1) {
    const document = snapshot.documents[documentIndex];
    const frameId = frameIdByDocumentIndex.get(documentIndex);
    if (!frameId) {
      throw new ObservationError('OBSERVATION_FAILED', 'DOM snapshot document is missing frame mapping');
    }

    const parsed = parseDomSnapshotDocument(
      snapshot,
      document,
      frameId,
      scrollX,
      scrollY,
      documentOrder,
    );
    allNodes.push(...parsed.nodes);
    documentOrder = parsed.nextDocumentOrder;
  }

  return {
    nodes: allNodes,
    domNodeCount: allNodes.length,
  };
}
