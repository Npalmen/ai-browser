import { OBSERVATION_BUDGETS } from './budgets';
import type {
  CdpAccessibilityTreeResponse,
  CdpDomSnapshotResponse,
  CdpFrameTreeNode,
  CdpFrameTreeResponse,
  CdpLayoutMetricsResponse,
} from './cdp-types';
import { parseAccessibilityTree } from './ax-parser';
import type { NormalizedDomNode } from './dom-snapshot-parser';
import { parseDomSnapshot } from './dom-snapshot-parser';
import type { DocumentIdentity } from './document-identity';
import {
  ObservationPriority,
  type ObservationCandidate,
  type ObservationPriorityValue,
} from './observation-builder';
import { ObservationError } from '../shared/observation-types';
import type { FrameId, PageObservation } from '../shared/observation-types';

const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'tab',
  'menuitem',
  'treeitem',
  'spinbutton',
]);

const INTERACTIVE_DOM_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
const HEADING_DOM_TAGS = new Set(['h1', 'h2', 'h3']);
const LANDMARK_AX_ROLES = new Set(['main', 'navigation', 'form', 'search', 'banner']);
const LANDMARK_DOM_TAGS = new Set(['main', 'nav', 'form', 'header']);
const NOISE_DOM_TAGS = new Set(['html', 'head', 'meta', 'script', 'style', 'link', 'noscript']);

interface FrameInfo {
  frameId: FrameId;
  parentFrameId?: FrameId;
  url?: string;
  securityOrigin?: string;
}

export interface NormalizeCollectedSourcesInput {
  frameTree: CdpFrameTreeResponse;
  layoutMetrics: CdpLayoutMetricsResponse;
  accessibilityTree: CdpAccessibilityTreeResponse;
  domSnapshot: CdpDomSnapshotResponse;
  documentIdentity: DocumentIdentity;
  pageMetadata: {
    url: string;
    title: string;
    loading: boolean;
  };
}

export interface NormalizedObservationSources {
  document: PageObservation['document'];
  viewport: PageObservation['viewport'];
  candidates: ObservationCandidate[];
  sourceStats: {
    sourceAxNodeCount: number;
    sourceDomNodeCount: number;
    frameCount: number;
    crossOriginFrameCount: number;
  };
}

function parseFrameTree(frameTree: CdpFrameTreeResponse): {
  frames: Map<FrameId, FrameInfo>;
  frameCount: number;
  mainFrameOrigin?: string;
} {
  const frames = new Map<FrameId, FrameInfo>();
  let frameCount = 0;
  let mainFrameOrigin: string | undefined;

  const walk = (node: CdpFrameTreeNode, parentFrameId?: FrameId): void => {
    const frameId = node.frame.id?.trim();
    if (!frameId) {
      throw new ObservationError('OBSERVATION_FAILED', 'Frame tree node is missing frame id');
    }

    frameCount += 1;
    const info: FrameInfo = {
      frameId,
      parentFrameId,
      url: node.frame.url,
      securityOrigin: node.frame.securityOrigin,
    };
    frames.set(frameId, info);

    if (!parentFrameId) {
      mainFrameOrigin = info.securityOrigin;
    }

    for (const child of node.childFrames ?? []) {
      walk(child, frameId);
    }
  };

  walk(frameTree.frameTree);
  return { frames, frameCount, mainFrameOrigin };
}

function isSameOriginFrame(frame: FrameInfo, mainFrameOrigin?: string): boolean {
  if (!mainFrameOrigin || !frame.securityOrigin) {
    return false;
  }

  return frame.securityOrigin === mainFrameOrigin;
}

function buildDocumentFrameMap(
  snapshot: CdpDomSnapshotResponse,
  mainFrameId: FrameId,
): Map<number, FrameId> {
  const map = new Map<number, FrameId>();
  map.set(0, mainFrameId);

  for (let index = 1; index < snapshot.documents.length; index += 1) {
    const frameId = snapshot.documents[index].frameId?.trim();
    if (frameId) {
      map.set(index, frameId);
    }
  }

  return map;
}

function deriveViewport(layoutMetrics: CdpLayoutMetricsResponse): PageObservation['viewport'] {
  const visual = layoutMetrics.cssVisualViewport;
  const layout = layoutMetrics.cssLayoutViewport;

  const width = visual?.clientWidth ?? layout?.clientWidth ?? 0;
  const height = visual?.clientHeight ?? layout?.clientHeight ?? 0;
  const scrollX = visual?.pageX ?? layout?.pageX ?? 0;
  const scrollY = visual?.pageY ?? layout?.pageY ?? 0;

  // Electron/CDP exposes visual viewport scale as the reliable deviceScaleFactor source.
  const deviceScaleFactor = visual?.scale ?? 1;

  if (width <= 0 || height <= 0) {
    throw new ObservationError('OBSERVATION_FAILED', 'Layout metrics are missing viewport dimensions');
  }

  return {
    width,
    height,
    scrollX,
    scrollY,
    deviceScaleFactor,
  };
}

function isDomVisible(dom: NormalizedDomNode, axHidden?: boolean): boolean {
  if (axHidden) {
    return false;
  }

  if (dom.display === 'none' || dom.visibility === 'hidden' || dom.opacity === 0) {
    return false;
  }

  if (dom.bounds && (dom.bounds.width <= 0 || dom.bounds.height <= 0)) {
    return false;
  }

  return true;
}

function intersectsViewport(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: PageObservation['viewport'],
): boolean {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;

  return right > 0 && bottom > 0 && bounds.x < viewport.width && bounds.y < viewport.height;
}

function isNearViewport(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: PageObservation['viewport'],
): boolean {
  const margin = OBSERVATION_BUDGETS.nearViewportMarginPx;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;

  return (
    right >= -margin &&
    bottom >= -margin &&
    bounds.x <= viewport.width + margin &&
    bounds.y <= viewport.height + margin
  );
}

function isInteractive(
  role: string,
  tag?: string,
  ax?: { focusable?: boolean; editable?: boolean },
  attributes?: Record<string, string>,
): boolean {
  if (INTERACTIVE_AX_ROLES.has(role) || ax?.focusable || ax?.editable) {
    return true;
  }

  if (tag && INTERACTIVE_DOM_TAGS.has(tag)) {
    return true;
  }

  if (attributes?.contenteditable === 'true' || attributes?.contenteditable === '') {
    return true;
  }

  return false;
}

function isHeading(role: string, tag?: string): boolean {
  return role === 'heading' || (tag ? HEADING_DOM_TAGS.has(tag) : false);
}

function isLandmark(role: string, tag?: string): boolean {
  return LANDMARK_AX_ROLES.has(role) || (tag ? LANDMARK_DOM_TAGS.has(tag) : false);
}

function assignPriority(
  candidate: {
    interactive: boolean;
    visible: boolean;
    inViewport: boolean;
    focused?: boolean;
    editable?: boolean;
    role: string;
    tag?: string;
    text?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  },
  viewport: PageObservation['viewport'],
): ObservationPriorityValue {
  const nearViewport = candidate.bounds ? isNearViewport(candidate.bounds, viewport) : false;

  if (candidate.visible && candidate.interactive && candidate.inViewport) {
    return ObservationPriority.VisibleInteractiveInViewport;
  }

  if (candidate.focused || candidate.editable) {
    return ObservationPriority.FocusedOrEditable;
  }

  if (candidate.visible && isHeading(candidate.role, candidate.tag) && candidate.inViewport) {
    return ObservationPriority.HeadingInViewport;
  }

  if (
    candidate.visible &&
    candidate.text &&
    candidate.text.trim().length > 0 &&
    candidate.inViewport
  ) {
    return ObservationPriority.VisibleMeaningfulTextInViewport;
  }

  if (candidate.visible && isLandmark(candidate.role, candidate.tag) && candidate.inViewport) {
    return ObservationPriority.LandmarkInViewport;
  }

  if (candidate.visible && nearViewport) {
    return ObservationPriority.NearViewport;
  }

  return ObservationPriority.StructuralContext;
}

function isNoiseDomNode(dom: NormalizedDomNode, visible: boolean, interactive: boolean): boolean {
  if (interactive || !visible) {
    return false;
  }

  if (dom.tag && NOISE_DOM_TAGS.has(dom.tag)) {
    return true;
  }

  if (dom.nodeType === 3 && (!dom.text || dom.text.trim().length === 0)) {
    return true;
  }

  if (
    dom.nodeType === 1 &&
    !dom.text &&
    !dom.tag &&
    Object.keys(dom.attributes).length === 0 &&
    !dom.bounds
  ) {
    return true;
  }

  return false;
}

function buildIframePlaceholder(
  dom: NormalizedDomNode,
  childFrameId: FrameId,
  viewport: PageObservation['viewport'],
): ObservationCandidate {
  const visible = isDomVisible(dom);
  const inViewport = dom.bounds ? intersectsViewport(dom.bounds, viewport) : false;

  const candidate: ObservationCandidate = {
    frameId: childFrameId,
    role: 'iframe',
    name: dom.attributes.title || dom.attributes.name,
    tag: 'iframe',
    interactive: false,
    visible,
    inViewport,
    bounds: dom.bounds,
    attributes: Object.keys(dom.attributes).length > 0 ? dom.attributes : undefined,
    priority: ObservationPriority.StructuralContext,
    documentOrder: dom.documentOrder,
    targetIdentity: { backendNodeId: dom.backendNodeId },
  };

  candidate.priority = assignPriority(candidate, viewport);
  return candidate;
}

function mergeCandidate(
  dom: NormalizedDomNode,
  ax: {
    axNodeId: string;
    role: string;
    name?: string;
    value?: string;
    description?: string;
    disabled?: boolean;
    focused?: boolean;
    checked?: boolean | 'mixed';
    selected?: boolean;
    expanded?: boolean;
    editable?: boolean;
    hidden?: boolean;
    focusable?: boolean;
  },
  viewport: PageObservation['viewport'],
): ObservationCandidate {
  const role = ax.role || dom.tag || 'generic';
  const name = ax.name ?? (ax.description && !ax.name ? ax.description : undefined);
  const text =
    dom.text && dom.text !== name && dom.text !== ax.value ? dom.text : undefined;
  const visible = isDomVisible(dom, ax.hidden);
  const inViewport = dom.bounds ? intersectsViewport(dom.bounds, viewport) : false;
  const interactive = isInteractive(role, dom.tag, ax, dom.attributes);

  const candidate: ObservationCandidate = {
    frameId: dom.frameId,
    role,
    name,
    value: ax.value,
    text,
    tag: dom.tag,
    interactive,
    visible,
    inViewport,
    focused: ax.focused,
    editable: ax.editable,
    disabled: ax.disabled,
    checked: ax.checked,
    selected: ax.selected,
    expanded: ax.expanded,
    bounds: dom.bounds,
    attributes: Object.keys(dom.attributes).length > 0 ? dom.attributes : undefined,
    targetIdentity: {
      backendNodeId: dom.backendNodeId,
      axNodeId: ax.axNodeId,
    },
    priority: ObservationPriority.StructuralContext,
    documentOrder: dom.documentOrder,
  };

  candidate.priority = assignPriority(candidate, viewport);
  return candidate;
}

function buildDomOnlyCandidate(
  dom: NormalizedDomNode,
  viewport: PageObservation['viewport'],
): ObservationCandidate | null {
  const role = dom.tag === 'iframe' ? 'iframe' : dom.nodeType === 3 ? 'text' : dom.tag ?? 'generic';
  const visible = isDomVisible(dom);
  const inViewport = dom.bounds ? intersectsViewport(dom.bounds, viewport) : false;
  const interactive = isInteractive(role, dom.tag, undefined, dom.attributes);

  if (isNoiseDomNode(dom, visible, interactive)) {
    return null;
  }

  const candidate: ObservationCandidate = {
    frameId: dom.frameId,
    role,
    text: dom.text,
    tag: dom.tag,
    interactive,
    visible,
    inViewport,
    bounds: dom.bounds,
    attributes: Object.keys(dom.attributes).length > 0 ? dom.attributes : undefined,
    targetIdentity: { backendNodeId: dom.backendNodeId },
    priority: ObservationPriority.StructuralContext,
    documentOrder: dom.documentOrder,
  };

  candidate.priority = assignPriority(candidate, viewport);
  return candidate;
}

function buildAxOnlyCandidate(
  ax: ReturnType<typeof parseAccessibilityTree>['nodes'][number],
  mainFrameId: FrameId,
  viewport: PageObservation['viewport'],
): ObservationCandidate | null {
  const interactive = isInteractive(ax.role, undefined, ax);
  const visible = !ax.hidden;

  const candidate: ObservationCandidate = {
    frameId: mainFrameId,
    role: ax.role,
    name: ax.name ?? ax.description,
    value: ax.value,
    interactive,
    visible,
    inViewport: false,
    focused: ax.focused,
    editable: ax.editable,
    disabled: ax.disabled,
    checked: ax.checked,
    selected: ax.selected,
    expanded: ax.expanded,
    priority: ObservationPriority.StructuralContext,
    documentOrder: ax.documentOrder + 100_000,
  };

  candidate.priority = assignPriority(candidate, viewport);
  return candidate;
}

export function normalizeCollectedSources(
  input: NormalizeCollectedSourcesInput,
): NormalizedObservationSources {
  const { frames, frameCount, mainFrameOrigin } = parseFrameTree(input.frameTree);
  const viewport = deriveViewport(input.layoutMetrics);
  const frameIdByDocumentIndex = buildDocumentFrameMap(
    input.domSnapshot,
    input.documentIdentity.mainFrameId,
  );

  const crossOriginDocumentIndexes = new Set<number>();
  const crossOriginFrameIds = new Set<FrameId>();
  let crossOriginFrameCount = 0;

  for (let documentIndex = 1; documentIndex < input.domSnapshot.documents.length; documentIndex += 1) {
    const frameId = frameIdByDocumentIndex.get(documentIndex);
    if (!frameId) {
      continue;
    }

    const frame = frames.get(frameId);
    if (frame && !isSameOriginFrame(frame, mainFrameOrigin)) {
      crossOriginDocumentIndexes.add(documentIndex);
      crossOriginFrameIds.add(frameId);
      crossOriginFrameCount += 1;
    }
  }

  const isCrossOriginInterior = (frameId: FrameId): boolean => crossOriginFrameIds.has(frameId);

  const domSnapshot = parseDomSnapshot(
    input.domSnapshot,
    frameIdByDocumentIndex,
    viewport.scrollX,
    viewport.scrollY,
  );

  const axSnapshot = parseAccessibilityTree(input.accessibilityTree);
  const axByBackendId = new Map<number, (typeof axSnapshot.nodes)[number]>();
  for (const axNode of axSnapshot.nodes) {
    if (axNode.backendDOMNodeId !== undefined) {
      axByBackendId.set(axNode.backendDOMNodeId, axNode);
    }
  }

  const domByBackendId = new Map<number, NormalizedDomNode>();
  for (const domNode of domSnapshot.nodes) {
    domByBackendId.set(domNode.backendNodeId, domNode);
  }

  const consumedDomIds = new Set<number>();
  const consumedAxIds = new Set<string>();
  const candidates: ObservationCandidate[] = [];

  for (const axNode of axSnapshot.nodes) {
    const backendId = axNode.backendDOMNodeId;
    if (backendId === undefined) {
      const axOnly = buildAxOnlyCandidate(axNode, input.documentIdentity.mainFrameId, viewport);
      if (axOnly) {
        candidates.push(axOnly);
      }
      continue;
    }

    const domNode = domByBackendId.get(backendId);
    if (!domNode) {
      const axOnly = buildAxOnlyCandidate(axNode, input.documentIdentity.mainFrameId, viewport);
      if (axOnly) {
        candidates.push(axOnly);
      }
      continue;
    }

    if (isCrossOriginInterior(domNode.frameId) && domNode.tag !== 'iframe') {
      continue;
    }

    if (domNode.contentDocumentIndex !== undefined) {
      const childDocumentIndex = domNode.contentDocumentIndex;
      if (crossOriginDocumentIndexes.has(childDocumentIndex)) {
        const childFrameId = frameIdByDocumentIndex.get(childDocumentIndex) ?? domNode.frameId;
        candidates.push(buildIframePlaceholder(domNode, childFrameId, viewport));
        consumedDomIds.add(domNode.backendNodeId);
        consumedAxIds.add(axNode.axNodeId);
        continue;
      }
    }

    candidates.push(mergeCandidate(domNode, axNode, viewport));
    consumedDomIds.add(domNode.backendNodeId);
    consumedAxIds.add(axNode.axNodeId);
  }

  for (const domNode of domSnapshot.nodes) {
    if (consumedDomIds.has(domNode.backendNodeId)) {
      continue;
    }

    if (isCrossOriginInterior(domNode.frameId) && domNode.tag !== 'iframe') {
      continue;
    }

    if (domNode.contentDocumentIndex !== undefined) {
      const childDocumentIndex = domNode.contentDocumentIndex;
      if (crossOriginDocumentIndexes.has(childDocumentIndex)) {
        const childFrameId = frameIdByDocumentIndex.get(childDocumentIndex) ?? domNode.frameId;
        candidates.push(buildIframePlaceholder(domNode, childFrameId, viewport));
        consumedDomIds.add(domNode.backendNodeId);
        continue;
      }
    }

    const domOnly = buildDomOnlyCandidate(domNode, viewport);
    if (domOnly) {
      candidates.push(domOnly);
    }
  }

  return {
    document: {
      revision: input.documentIdentity.revision,
      url: input.pageMetadata.url,
      title: input.pageMetadata.title,
      loading: input.pageMetadata.loading,
      mainFrameId: input.documentIdentity.mainFrameId,
    },
    viewport,
    candidates,
    sourceStats: {
      sourceAxNodeCount: axSnapshot.axNodeCount,
      sourceDomNodeCount: domSnapshot.domNodeCount,
      frameCount,
      crossOriginFrameCount,
    },
  };
}
