export const OBSERVATION_ATTRIBUTE_ALLOWLIST = [
  'type',
  'href',
  'placeholder',
  'autocomplete',
  'alt',
] as const;

export type ObservationAttributeName = (typeof OBSERVATION_ATTRIBUTE_ALLOWLIST)[number];

export interface ObservationBudgetConfig {
  maxEmittedNodes: number;
  maxTextCharsPerNode: number;
  maxTotalTextChars: number;
  maxAttributesPerNode: number;
  maxAttributeValueChars: number;
  maxNativeSelectOptionsPerSelect: number;
  nearViewportMarginPx: number;
  screenshotMaxLongestEdge: number;
  screenshotJpegQuality: number;
  maxScreenshotBase64Chars: number;
}

export const OBSERVATION_BUDGETS: ObservationBudgetConfig = {
  maxEmittedNodes: 400,
  maxTextCharsPerNode: 200,
  maxTotalTextChars: 12_000,
  maxAttributesPerNode: 4,
  maxAttributeValueChars: 200,
  maxNativeSelectOptionsPerSelect: 50,
  nearViewportMarginPx: 100,
  screenshotMaxLongestEdge: 1280,
  screenshotJpegQuality: 70,
  maxScreenshotBase64Chars: 400_000,
};
