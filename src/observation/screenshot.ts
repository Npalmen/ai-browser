import type { NativeImage, WebContents } from 'electron';

import { OBSERVATION_BUDGETS } from './budgets';
import type { ObservationScreenshot } from '../shared/observation-types';

// Local observation screenshots may contain on-screen secrets.
// Future remote-model export must be separately gated.

export interface CaptureObservationScreenshotResult {
  screenshot?: ObservationScreenshot;
  screenshotTruncated: boolean;
}

export interface ResizeDimensions {
  width: number;
  height: number;
}

export function resolveInitialResizeDimensions(
  width: number,
  height: number,
  maxLongestEdge: number = OBSERVATION_BUDGETS.screenshotMaxLongestEdge,
): ResizeDimensions | null {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= maxLongestEdge) {
    return null;
  }

  if (width >= height) {
    return {
      width: maxLongestEdge,
      height: Math.max(1, Math.round((height * maxLongestEdge) / width)),
    };
  }

  return {
    width: Math.max(1, Math.round((width * maxLongestEdge) / height)),
    height: maxLongestEdge,
  };
}

export function resolveSecondPassDimensions(
  width: number,
  height: number,
  actualBase64Chars: number,
  maxBase64Chars: number = OBSERVATION_BUDGETS.maxScreenshotBase64Chars,
): ResizeDimensions {
  const ratio = Math.sqrt(maxBase64Chars / actualBase64Chars);
  const conservativeRatio = ratio * 0.95;

  return {
    width: Math.max(1, Math.round(width * conservativeRatio)),
    height: Math.max(1, Math.round(height * conservativeRatio)),
  };
}

export function isEncodedScreenshotOverBudget(
  base64Length: number,
  maxBase64Chars: number = OBSERVATION_BUDGETS.maxScreenshotBase64Chars,
): boolean {
  return base64Length > maxBase64Chars;
}

function resizeNativeImage(
  image: NativeImage,
  dimensions: ResizeDimensions,
): NativeImage {
  if (dimensions.width >= dimensions.height) {
    return image.resize({ width: dimensions.width, quality: 'best' });
  }

  return image.resize({ height: dimensions.height, quality: 'best' });
}

function encodeScreenshot(image: NativeImage): ObservationScreenshot {
  // Raster dimensions from the encoded image, not CSS viewport geometry.
  const { width, height } = image.getSize();
  const data = image.toJPEG(OBSERVATION_BUDGETS.screenshotJpegQuality).toString('base64');

  return {
    mimeType: 'image/jpeg',
    width,
    height,
    encoding: 'base64',
    data,
  };
}

export async function captureObservationScreenshot(
  webContents: WebContents,
): Promise<CaptureObservationScreenshotResult> {
  try {
    const image = await webContents.capturePage();
    if (image.isEmpty()) {
      return { screenshotTruncated: true };
    }

    let processed = image;
    const initialSize = processed.getSize();
    const initialResize = resolveInitialResizeDimensions(initialSize.width, initialSize.height);
    if (initialResize) {
      processed = resizeNativeImage(processed, initialResize);
    }

    let encoded = encodeScreenshot(processed);
    if (isEncodedScreenshotOverBudget(encoded.data.length)) {
      const secondPass = resolveSecondPassDimensions(
        encoded.width,
        encoded.height,
        encoded.data.length,
      );
      processed = processed.resize({
        width: secondPass.width,
        height: secondPass.height,
        quality: 'best',
      });
      encoded = encodeScreenshot(processed);

      if (isEncodedScreenshotOverBudget(encoded.data.length)) {
        return { screenshotTruncated: true };
      }
    }

    return {
      screenshot: encoded,
      screenshotTruncated: false,
    };
  } catch {
    return { screenshotTruncated: true };
  }
}
