import type { CdpBoxModelQuad } from '../observation/interaction-cdp-types';

export const INTERACTION_BOUNDS_DRIFT_TOLERANCE_PX = 12;

export interface LiveBoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function quadToRect(quad: number[] | undefined): LiveBoxRect | null {
  if (!quad || quad.length < 8) {
    return null;
  }

  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];

  if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) {
    return null;
  }

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width,
    height,
  };
}

export function extractLiveBoxRect(model: CdpBoxModelQuad | undefined): LiveBoxRect | null {
  if (!model) {
    return null;
  }

  return quadToRect(model.content) ?? quadToRect(model.border) ?? quadToRect(model.padding);
}

export function liveBoxCenter(box: LiveBoxRect): { x: number; y: number } {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

export function observedBoundsDriftExceeded(
  observed: LiveBoxRect,
  live: LiveBoxRect,
  tolerancePx = INTERACTION_BOUNDS_DRIFT_TOLERANCE_PX,
): boolean {
  const observedCenter = liveBoxCenter(observed);
  const liveCenter = liveBoxCenter(live);

  return (
    Math.abs(observedCenter.x - liveCenter.x) > tolerancePx ||
    Math.abs(observedCenter.y - liveCenter.y) > tolerancePx
  );
}
