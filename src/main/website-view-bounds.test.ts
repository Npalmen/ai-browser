import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AI_SIDE_PANEL_WIDTH_PX } from '../shared/ai-types';
import { calculateWebsiteViewBounds, CHROME_HEIGHT, normalizeRightInset } from './website-view-bounds';

describe('calculateWebsiteViewBounds', () => {
  it('uses the full content width when the inset is 0', () => {
    assert.deepEqual(calculateWebsiteViewBounds(1024, 768, 0), {
      x: 0,
      y: CHROME_HEIGHT,
      width: 1024,
      height: 768 - CHROME_HEIGHT,
    });
  });

  it('narrows the website by the trusted right inset', () => {
    assert.deepEqual(calculateWebsiteViewBounds(1024, 768, AI_SIDE_PANEL_WIDTH_PX), {
      x: 0,
      y: CHROME_HEIGHT,
      width: 1024 - AI_SIDE_PANEL_WIDTH_PX,
      height: 768 - CHROME_HEIGHT,
    });
  });

  it('clamps a negative inset to zero', () => {
    assert.equal(normalizeRightInset(-20), 0);
    assert.equal(calculateWebsiteViewBounds(1024, 768, -20).width, 1024);
  });

  it('clamps a non-finite inset to zero', () => {
    assert.equal(normalizeRightInset(Number.NaN), 0);
    assert.equal(normalizeRightInset(Number.POSITIVE_INFINITY), 0);
  });

  it('does not produce a negative website width when the inset exceeds content width', () => {
    assert.equal(calculateWebsiteViewBounds(1024, 768, 2000).width, 0);
  });
});
