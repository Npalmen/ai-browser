import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isEncodedScreenshotOverBudget,
  resolveInitialResizeDimensions,
  resolveSecondPassDimensions,
} from './screenshot';
import { OBSERVATION_BUDGETS } from './budgets';

describe('screenshot sizing helpers', () => {
  it('keeps images at or below the max edge unchanged', () => {
    assert.equal(resolveInitialResizeDimensions(800, 600), null);
    assert.equal(resolveInitialResizeDimensions(640, 480), null);
    assert.equal(resolveInitialResizeDimensions(1280, 720), null);
  });

  it('downscales landscape images to a 1280 longest edge', () => {
    const resized = resolveInitialResizeDimensions(1600, 900);
    assert.ok(resized);
    assert.equal(Math.max(resized.width, resized.height), 1280);
    assert.equal(resized.width, 1280);
    assert.equal(resized.height, 720);
  });

  it('downscales portrait images to a 1280 longest edge', () => {
    const resized = resolveInitialResizeDimensions(900, 1600);
    assert.ok(resized);
    assert.equal(Math.max(resized.width, resized.height), 1280);
    assert.equal(resized.height, 1280);
    assert.equal(resized.width, 720);
  });

  it('computes a smaller second pass while preserving aspect ratio approximately', () => {
    const secondPass = resolveSecondPassDimensions(1280, 720, 800_000);
    assert.ok(secondPass.width < 1280);
    assert.ok(secondPass.height < 720);
    assert.ok(secondPass.width >= 1);
    assert.ok(secondPass.height >= 1);

    const aspectBefore = 1280 / 720;
    const aspectAfter = secondPass.width / secondPass.height;
    assert.ok(Math.abs(aspectBefore - aspectAfter) < 0.05);
  });

  it('detects encoded screenshots over the base64 budget', () => {
    assert.equal(isEncodedScreenshotOverBudget(399_999), false);
    assert.equal(isEncodedScreenshotOverBudget(400_000), false);
    assert.equal(isEncodedScreenshotOverBudget(400_001), true);
    assert.equal(
      isEncodedScreenshotOverBudget(500_000, OBSERVATION_BUDGETS.maxScreenshotBase64Chars),
      true,
    );
  });
});
