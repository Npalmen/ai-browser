import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PageObservation } from '../shared/observation-types';
import { MAX_VIEWPORT_DISCOVERY_SCROLLS } from '../shared/viewport-discovery-policy';
import {
  createViewportDiscoveryState,
  shouldRejectPrematureTargetNotFound,
  updateViewportDiscoveryStateAfterScroll,
} from './viewport-discovery-state';

function observation(scrollY: number, documentHeight = 2400): PageObservation {
  return {
    observationId: `obs-${scrollY}`,
    tabId: 'tab-1',
    capturedAt: 1,
    document: {
      revision: 'rev-a',
      url: 'https://example.com/page',
      title: 'Page',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: {
      width: 400,
      height: 300,
      scrollX: 0,
      scrollY,
      deviceScaleFactor: 1,
      documentHeight,
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

function boundScroll(
  direction: 'up' | 'down',
  revision = 'rev-a',
  observationId = 'obs-1',
): {
  kind: 'scroll';
  mode: 'viewport';
  direction: 'up' | 'down';
  amountPx: number;
  tabId: 'tab-1';
  observationId: string;
  documentRevision: string;
} {
  return {
    kind: 'scroll',
    mode: 'viewport',
    direction,
    amountPx: 300,
    tabId: 'tab-1',
    observationId,
    documentRevision: revision,
  };
}

describe('viewport discovery state', () => {
  it('rejects target-not-found near top when content remains below', () => {
    const state = createViewportDiscoveryState(observation(0));
    assert.equal(
      shouldRejectPrematureTargetNotFound(observation(0), false, state),
      true,
    );
  });

  it('rejects target-not-found near bottom when content remains above and upward search never ran', () => {
    const atBottom = observation(2100);
    const state = createViewportDiscoveryState(atBottom);
    assert.equal(shouldRejectPrematureTargetNotFound(atBottom, false, state), true);
  });

  it('accepts target-not-found after a downward sweep from the top reaches the bottom', () => {
    const atBottom = observation(2100);
    const state = createViewportDiscoveryState(observation(0));
    updateViewportDiscoveryStateAfterScroll(
      state,
      boundScroll('down', 'rev-a', 'obs-0'),
      observation(0),
      observation(300),
    );
    updateViewportDiscoveryStateAfterScroll(
      state,
      boundScroll('down', 'rev-a', 'obs-300'),
      observation(300),
      observation(600),
    );
    updateViewportDiscoveryStateAfterScroll(
      state,
      boundScroll('down', 'rev-a', 'obs-600'),
      observation(600),
      atBottom,
    );
    assert.equal(state.reachedBottom, true);
    assert.equal(state.reachedTop, true);
    assert.equal(shouldRejectPrematureTargetNotFound(atBottom, true, state), false);
  });

  it('rejects target-not-found at bottom when only downward discovery ran from deep in page', () => {
    const atBottom = observation(2100);
    const state = createViewportDiscoveryState(atBottom);
    updateViewportDiscoveryStateAfterScroll(
      state,
      boundScroll('down', 'rev-a', 'obs-2100'),
      atBottom,
      atBottom,
    );
    assert.equal(state.reachedBottom, true);
    assert.equal(state.reachedTop, false);
    assert.equal(shouldRejectPrematureTargetNotFound(atBottom, true, state), true);
  });

  it('tracks repeated upward scrolling until top is reached', () => {
    const state = createViewportDiscoveryState(observation(900));
    const scrollYs = [900, 500, 100, 0];
    for (let index = 1; index < scrollYs.length; index += 1) {
      const pre = observation(scrollYs[index - 1]);
      const post = observation(scrollYs[index]);
      updateViewportDiscoveryStateAfterScroll(
        state,
        boundScroll('up', 'rev-a', pre.observationId),
        pre,
        post,
      );
      state.consecutiveViewportScrolls += 1;
    }
    assert.equal(state.searchedUp, 3);
    assert.equal(state.reachedTop, true);
    assert.equal(state.viewportProgressGeneration, 3);
  });

  it('recognizes bottom on no-progress downward scroll', () => {
    const atBottom = observation(2100);
    const state = createViewportDiscoveryState(atBottom);
    updateViewportDiscoveryStateAfterScroll(
      state,
      boundScroll('down', 'rev-a', atBottom.observationId),
      atBottom,
      atBottom,
    );
    assert.equal(state.reachedBottom, true);
    assert.equal(state.viewportProgressGeneration, 0);
  });

  it('recognizes top on no-progress upward scroll', () => {
    const atTop = observation(0);
    const state = createViewportDiscoveryState(atTop);
    updateViewportDiscoveryStateAfterScroll(
      state,
      boundScroll('up', 'rev-a', atTop.observationId),
      atTop,
      atTop,
    );
    assert.equal(state.reachedTop, true);
    assert.equal(state.viewportProgressGeneration, 0);
  });

  it('accepts target-not-found once discovery scroll budget is exhausted', () => {
    const atBottom = observation(2100);
    const state = createViewportDiscoveryState(atBottom);
    state.consecutiveViewportScrolls = MAX_VIEWPORT_DISCOVERY_SCROLLS;
    assert.equal(shouldRejectPrematureTargetNotFound(atBottom, true, state), false);
  });
});
