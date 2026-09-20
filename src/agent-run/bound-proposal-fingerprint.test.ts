import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fingerprintAction } from './action-fingerprint';
import { fingerprintBoundProposal } from './bound-proposal-fingerprint';
import type { BoundInteractionProposal } from '../shared/interaction-types';
import type { PageObservation } from '../shared/observation-types';

function pageObservation(scrollY = 0): PageObservation {
  return {
    observationId: 'obs-1',
    tabId: 'tab-1',
    capturedAt: 1,
    document: {
      revision: 'rev-1',
      url: 'https://example.com/page',
      title: 'Example page',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: {
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY,
      deviceScaleFactor: 1,
    },
    nodes: [],
    stats: {
      sourceAxNodeCount: 0,
      sourceDomNodeCount: 0,
      emittedNodeCount: 0,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
  };
}

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
      fingerprintBoundProposal(click, pageObservation()),
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
      fingerprintBoundProposal(type, pageObservation()),
      fingerprintAction({
        kind: 'type',
        documentRevision: 'rev-1',
        targetId: 'target-a',
        text: 'secret-canary',
      }),
    );
  });

  it('includes pre-action viewport position for viewport scroll fingerprints', () => {
    const scroll: BoundInteractionProposal = {
      kind: 'scroll',
      mode: 'viewport',
      direction: 'down',
      amountPx: 500,
      tabId: 'tab-1',
      observationId: 'obs-1',
      documentRevision: 'rev-1',
    };
    const fromTop = fingerprintBoundProposal(scroll, pageObservation(0));
    const fromMiddle = fingerprintBoundProposal(scroll, pageObservation(500));
    assert.notEqual(fromTop, fromMiddle);
    assert.equal(
      fromTop,
      fingerprintAction({
        kind: 'scroll',
        mode: 'viewport',
        documentRevision: 'rev-1',
        direction: 'down',
        amountPx: 500,
        scrollX: 0,
        scrollY: 0,
      }),
    );
  });
});
