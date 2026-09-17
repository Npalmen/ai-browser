export const CHROME_HEIGHT = 88;

export function calculateWebsiteViewBounds(
  contentWidth: number,
  contentHeight: number,
  rightInsetPx = 0,
): { x: number; y: number; width: number; height: number } {
  const inset = normalizeRightInset(rightInsetPx);
  return {
    x: 0,
    y: CHROME_HEIGHT,
    width: Math.max(0, contentWidth - inset),
    height: Math.max(0, contentHeight - CHROME_HEIGHT),
  };
}

export function normalizeRightInset(rightInsetPx: number): number {
  if (!Number.isFinite(rightInsetPx) || rightInsetPx <= 0) {
    return 0;
  }
  return rightInsetPx;
}
