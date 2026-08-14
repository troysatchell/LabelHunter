/**
 * Finds the blank label region in a Gemini-generated backdrop photo
 * (design doc §5,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * `imagenPrompt.ts` asks Gemini to paint that region one known, distinct
 * color; this file scans the generated photo for the largest connected
 * region near that color and returns its 4 extreme corners — the same
 * "min/max of x+y and x-y" technique document-scanner apps use to find a
 * page's corners inside a photo. `compositeBackdrop.ts` warps the
 * renderer's label into the returned quad.
 */
import sharp from "sharp";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Just the 4 corners of a label placement — the shape `compositeBackdrop.ts`
 * actually needs. `src/lib/golden-set/types.ts`'s `LabelPlacementQuad`
 * (Task 1) matches this shape field-for-field but is declared separately
 * (a manifest case shouldn't import from `scripts/golden/`) — TypeScript's
 * structural typing makes the two interchangeable wherever only the
 * corners matter, which is everywhere except this file's own detection
 * bookkeeping (`pixelCount`, `imageWidth`, `imageHeight` below).
 */
export interface Quad {
  readonly topLeft: Point;
  readonly topRight: Point;
  readonly bottomLeft: Point;
  readonly bottomRight: Point;
}

export interface DetectedQuad extends Quad {
  readonly pixelCount: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Downsample width for the flood fill — fast, and corners are rescaled back
 * to full resolution. Exported so tests can compute the exact detection
 * height a given (originalWidth, originalHeight) pair resizes to, without
 * duplicating this number.
 */
export const DETECTION_WIDTH = 240;
/** A matched region smaller than this fraction of the frame is noise (a cap glint, a highlight), not the label. */
const MIN_REGION_FRACTION = 0.02;
/** A matched region larger than this fraction is a false match too — blown highlights or too-loose a tolerance color-matching most of the frame — not the label. */
const MAX_REGION_FRACTION = 0.85;

function colorDistance(a: RgbColor, b: RgbColor): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

export async function detectBlankRegionQuad(
  image: Buffer,
  targetColor: RgbColor,
  tolerance: number,
): Promise<DetectedQuad | null> {
  const originalMeta = await sharp(image).metadata();
  const originalWidth = originalMeta.width;
  const originalHeight = originalMeta.height;
  if (!originalWidth || !originalHeight) {
    throw new RangeError("blankRegionDetector: could not read image dimensions");
  }

  const scale = DETECTION_WIDTH / originalWidth;
  const detectionHeight = Math.max(1, Math.round(originalHeight * scale));
  const { data, info } = await sharp(image)
    .resize(DETECTION_WIDTH, detectionHeight, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const isMatch = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const offset = i * channels;
    const pixel: RgbColor = { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
    isMatch[i] = colorDistance(pixel, targetColor) <= tolerance ? 1 : 0;
  }

  // Iterative flood fill (explicit stack, not recursion) over 4-connected
  // matching pixels, keeping only the largest component found.
  const visited = new Uint8Array(width * height);
  let bestComponent: number[] = [];

  for (let start = 0; start < width * height; start++) {
    if (!isMatch[start] || visited[start]) continue;

    const component: number[] = [];
    const stack = [start];
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      component.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && isMatch[n] && !visited[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (component.length > bestComponent.length) {
      bestComponent = component;
    }
  }

  if (bestComponent.length < width * height * MIN_REGION_FRACTION || bestComponent.length > width * height * MAX_REGION_FRACTION) {
    return null;
  }

  let topLeft = { x: 0, y: 0, score: Infinity };
  let bottomRight = { x: 0, y: 0, score: -Infinity };
  let topRight = { x: 0, y: 0, score: -Infinity };
  let bottomLeft = { x: 0, y: 0, score: Infinity };

  for (const idx of bestComponent) {
    const x = idx % width;
    const y = Math.floor(idx / width);
    const sum = x + y;
    const diff = x - y;
    if (sum < topLeft.score) topLeft = { x, y, score: sum };
    if (sum > bottomRight.score) bottomRight = { x, y, score: sum };
    if (diff > topRight.score) topRight = { x, y, score: diff };
    if (diff < bottomLeft.score) bottomLeft = { x, y, score: diff };
  }

  // Two independent rescale factors, not one. `width` equals DETECTION_WIDTH
  // exactly (sharp resized to it), so the x factor is exact. `height` equals
  // `detectionHeight` — a ROUNDED value (see above) — so the real vertical
  // resize ratio sharp actually applied is `height / originalHeight`, not
  // `scale`. Reusing the horizontal factor for the vertical axis recorded a
  // wrong y coordinate whenever `originalHeight * scale` was not already an
  // integer.
  const toOriginal = (p: { x: number; y: number }): Point => ({
    x: Math.round((p.x * originalWidth) / width),
    y: Math.round((p.y * originalHeight) / height),
  });

  return {
    topLeft: toOriginal(topLeft),
    topRight: toOriginal(topRight),
    bottomLeft: toOriginal(bottomLeft),
    bottomRight: toOriginal(bottomRight),
    pixelCount: bestComponent.length,
    imageWidth: originalWidth,
    imageHeight: originalHeight,
  };
}
