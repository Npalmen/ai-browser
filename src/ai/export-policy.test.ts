import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideModelExport } from './export-policy';
import type { ModelProfile } from './model-types';

function profile(vision: boolean): Pick<ModelProfile, 'capabilities'> {
  return {
    capabilities: {
      text: true,
      vision,
      structuredOutput: true,
      reasoning: true,
    },
  };
}

describe('decideModelExport', () => {
  it('omits screenshots for a normal remote text request even if the profile can see images', () => {
    const decision = decideModelExport({
      privacy: 'remoteAllowed',
      needsVision: false,
      allowScreenshotExport: false,
      profile: profile(true),
      hasScreenshot: true,
    });

    assert.equal(decision.structuredExportAllowed, true);
    assert.equal(decision.screenshotExportAllowed, false);
    assert.equal(decision.privacy, 'remoteAllowed');
  });

  it('allows screenshot export only when every vision-export condition is true', () => {
    const decision = decideModelExport({
      privacy: 'remoteAllowed',
      needsVision: true,
      allowScreenshotExport: true,
      profile: profile(true),
      hasScreenshot: true,
    });

    assert.equal(decision.structuredExportAllowed, true);
    assert.equal(decision.screenshotExportAllowed, true);
  });

  it('omits screenshots when vision is requested but the profile cannot accept images', () => {
    const decision = decideModelExport({
      privacy: 'remoteAllowed',
      needsVision: true,
      allowScreenshotExport: true,
      profile: profile(false),
      hasScreenshot: true,
    });

    assert.equal(decision.screenshotExportAllowed, false);
  });

  it('forbids remote structured and screenshot export for localOnly', () => {
    const decision = decideModelExport({
      privacy: 'localOnly',
      needsVision: true,
      allowScreenshotExport: true,
      profile: profile(true),
      hasScreenshot: true,
    });

    assert.equal(decision.structuredExportAllowed, false);
    assert.equal(decision.screenshotExportAllowed, false);
    assert.equal(decision.privacy, 'localOnly');
  });
});
