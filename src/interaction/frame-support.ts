import type { CdpFrameTreeNode, CdpFrameTreeResponse } from '../observation/cdp-types';
import { extractDocumentIdentity } from '../observation/document-identity';

export interface FrameTreeInfo {
  mainFrameId: string;
  mainFrameOrigin?: string;
  frameIds: Set<string>;
  crossOriginFrameIds: Set<string>;
}

export function collectFrameTreeInfo(frameTree: CdpFrameTreeResponse): FrameTreeInfo {
  const identity = extractDocumentIdentity(frameTree);
  const frameIds = new Set<string>();
  const crossOriginFrameIds = new Set<string>();
  let mainFrameOrigin: string | undefined;

  const walk = (node: CdpFrameTreeNode, parentOrigin?: string): void => {
    const frameId = node.frame.id?.trim();
    if (!frameId) {
      return;
    }

    frameIds.add(frameId);
    const origin = node.frame.securityOrigin?.trim();

    if (!parentOrigin) {
      mainFrameOrigin = origin;
    } else if (!origin || origin !== parentOrigin) {
      crossOriginFrameIds.add(frameId);
    }

    for (const child of node.childFrames ?? []) {
      walk(child, parentOrigin ?? origin);
    }
  };

  walk(frameTree.frameTree);

  return {
    mainFrameId: identity.mainFrameId,
    mainFrameOrigin,
    frameIds,
    crossOriginFrameIds,
  };
}

export function isSupportedInteractionFrame(frameId: string, frameInfo: FrameTreeInfo): boolean {
  if (!frameInfo.frameIds.has(frameId)) {
    return false;
  }

  return !frameInfo.crossOriginFrameIds.has(frameId);
}
