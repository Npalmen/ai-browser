import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractLiveBoxRect,
  liveBoxCenter,
  observedBoundsDriftExceeded,
  quadToRect,
} from './box-model';

describe('box-model helpers', () => {
  it('derives a rect and center from a content quad', () => {
    const rect = quadToRect([10, 20, 30, 20, 30, 40, 10, 40]);
    assert.deepEqual(rect, { x: 10, y: 20, width: 20, height: 20 });
    assert.deepEqual(liveBoxCenter(rect!), { x: 20, y: 30 });
  });

  it('rejects invalid geometry', () => {
    assert.equal(quadToRect([0, 0, 0, 0, 0, 0, 0, 0]), null);
    assert.equal(extractLiveBoxRect({ content: [Number.NaN, 1, 2, 3, 4, 5, 6, 7] }), null);
  });

  it('detects drift beyond tolerance', () => {
    const observed = { x: 10, y: 10, width: 20, height: 20 };
    const live = { x: 30, y: 10, width: 20, height: 20 };
    assert.equal(observedBoundsDriftExceeded(observed, live, 12), true);
    assert.equal(observedBoundsDriftExceeded(observed, { x: 12, y: 10, width: 20, height: 20 }, 12), false);
  });
});
