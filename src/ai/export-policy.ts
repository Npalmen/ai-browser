import type { ModelPrivacyRequirement, ModelProfile } from './model-types';

export interface ModelExportDecision {
  structuredExportAllowed: boolean;
  screenshotExportAllowed: boolean;
  privacy: ModelPrivacyRequirement;
}

export interface DecideModelExportInput {
  privacy: ModelPrivacyRequirement;
  needsVision: boolean;
  allowScreenshotExport: boolean;
  profile: Pick<ModelProfile, 'capabilities'>;
  hasScreenshot: boolean;
}

export function decideModelExport(input: DecideModelExportInput): ModelExportDecision {
  const remoteAllowed = input.privacy === 'remoteAllowed';
  const structuredExportAllowed = remoteAllowed;
  const screenshotExportAllowed =
    remoteAllowed &&
    input.needsVision &&
    input.profile.capabilities.vision === true &&
    input.allowScreenshotExport &&
    input.hasScreenshot;

  return {
    structuredExportAllowed,
    screenshotExportAllowed,
    privacy: input.privacy,
  };
}
