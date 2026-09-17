import type { CdpFrameTreeResponse } from './cdp-types';
import { ObservationError } from '../shared/observation-types';
import type { DocumentRevision, FrameId } from '../shared/observation-types';

export type { CdpFrameTreeResponse };

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
