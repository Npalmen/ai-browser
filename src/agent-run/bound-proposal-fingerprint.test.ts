import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fingerprintAction } from './action-fingerprint';
import { fingerprintBoundProposal } from './bound-proposal-fingerprint';
import type { BoundInteractionProposal } from '../shared/interaction-types';

describe('fingerprintBoundProposal', () => {
  it('matches explicit fingerprintAction input for all proposal kinds', () => {
    const click: BoundInteractionProposal = {
      kind: 'click',
      targetId: 'target-a',
      tabId: 'tab-1',
      observationId: 'obs-1',
      documentRevision: 'rev-1',
    };
    assert.equal(
      fingerprintBoundProposal(click),
      fingerprintAction({
        kind: 'click',
        documentRevision: 'rev-1',
        targetId: 'target-a',
      }),
    );

    const type: BoundInteractionProposal = {
      kind: 'type',
      targetId: 'target-a',
      text: 'secret-canary',
      tabId: 'tab-1',
      observationId: 'obs-1',
      documentRevision: 'rev-1',
    };
    assert.equal(
      fingerprintBoundProposal(type),
      fingerprintAction({
        kind: 'type',
        documentRevision: 'rev-1',
        targetId: 'target-a',
        text: 'secret-canary',
      }),
    );
  });
});
