import { ObservationError } from '../shared/observation-types';
import type { DocumentRevision, FrameId } from '../shared/observation-types';

export interface CdpFrameTreeResponse {
  frameTree: {
    frame: {
      id?: string;
      loaderId?: string;
    };
  };
}

export interface DocumentIdentity {
  mainFrameId: FrameId;
  loaderId: string;
  revision: DocumentRevision;
}

export function extractDocumentIdentity(frameTree: CdpFrameTreeResponse): DocumentIdentity {
  const mainFrameId = frameTree.frameTree?.frame?.id?.trim();
  const loaderId = frameTree.frameTree?.frame?.loaderId?.trim();

  if (!mainFrameId || !loaderId) {
    throw new ObservationError('PAGE_NOT_READY', 'Document identity is not available');
  }

  return {
    mainFrameId,
    loaderId,
    revision: `${mainFrameId}:${loaderId}`,
  };
}
