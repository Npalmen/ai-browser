export interface CdpFrame {
  id?: string;
  loaderId?: string;
  url?: string;
  securityOrigin?: string;
}

export interface CdpFrameTreeNode {
  frame: CdpFrame;
  childFrames?: CdpFrameTreeNode[];
}

export interface CdpFrameTreeResponse {
  frameTree: CdpFrameTreeNode;
}

export interface CdpLayoutMetricsResponse {
  cssVisualViewport?: {
    offsetX?: number;
    offsetY?: number;
    pageX?: number;
    pageY?: number;
    clientWidth?: number;
    clientHeight?: number;
    scale?: number;
  };
  cssLayoutViewport?: {
    pageX?: number;
    pageY?: number;
    clientWidth?: number;
    clientHeight?: number;
  };
  cssContentSize?: {
    width?: number;
    height?: number;
  };
}

export interface CdpAxPropertyValue {
  type?: string;
  value?: string | boolean | number;
}

export interface CdpAxProperty {
  name?: string;
  value?: CdpAxPropertyValue;
}

export interface CdpAxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: CdpAxPropertyValue;
  name?: CdpAxPropertyValue;
  value?: CdpAxPropertyValue;
  description?: CdpAxPropertyValue;
  properties?: CdpAxProperty[];
  backendDOMNodeId?: number;
  childIds?: string[];
}

export interface CdpAccessibilityTreeResponse {
  nodes?: CdpAxNode[];
}

export interface CdpDomSnapshotRareStringData {
  index?: number[];
  value?: number[];
}

export interface CdpDomSnapshotRareBooleanData {
  index?: number[];
}

export interface CdpDomSnapshotNodes {
  parentIndex?: number[];
  nodeType?: number[];
  nodeName?: number[];
  nodeValue?: number[];
  backendNodeId?: number[];
  attributes?: number[] | number[][];
  attributeIndex?: CdpDomSnapshotRareStringData;
  textValue?: CdpDomSnapshotRareStringData;
  inputValue?: CdpDomSnapshotRareStringData;
  contentDocumentIndex?: CdpDomSnapshotRareStringData;
}

export interface CdpDomSnapshotLayout {
  nodeIndex?: number[];
  bounds?: number[] | number[][];
  styles?: number[];
}

export interface CdpDomSnapshotDocument {
  documentURL?: number;
  baseURL?: number;
  contentLanguage?: number;
  encodingName?: number;
  publicId?: number;
  systemId?: number;
  frameId?: string | number;
  nodes: CdpDomSnapshotNodes;
  layout: CdpDomSnapshotLayout;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
}

export interface CdpDomSnapshotResponse {
  strings: string[];
  documents: CdpDomSnapshotDocument[];
}
