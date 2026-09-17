import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractDocumentIdentity } from './document-identity';
import { ObservationError } from '../shared/observation-types';

describe('extractDocumentIdentity', () => {
  it('builds revision from main frame id and loader id', () => {
    const identity = extractDocumentIdentity({
      frameTree: {
        frame: {
          id: 'main-frame',
          loaderId: 'loader-1',
        },
      },
    });

    assert.equal(identity.mainFrameId, 'main-frame');
    assert.equal(identity.loaderId, 'loader-1');
    assert.equal(identity.revision, 'main-frame:loader-1');
  });

  it('fails closed when loader id is missing', () => {
    assert.throws(
      () =>
        extractDocumentIdentity({
          frameTree: {
            frame: {
              id: 'main-frame',
            },
          },
        }),
      (error: unknown) => error instanceof ObservationError && error.code === 'PAGE_NOT_READY',
    );
  });
});
