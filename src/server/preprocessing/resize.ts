/**
 * Resize math for the Haiku/Sonnet vision variants (TRO-460 / LH-010,
 * PRD §3.1). Pure and deterministic — no image decoding — so it is unit
 * tested directly against PRD §6's TDD mandate for router/normalizer-style
 * pure functions.
 */

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Computes the dimensions of `source` resized so its long edge is at most
 * `maxLongEdgePx`, preserving aspect ratio. Never upscales: a source
 * already at or under the cap keeps its original dimensions unchanged.
 *
 * Rounds to the nearest whole pixel — sharp's resize target must be an
 * integer.
 */
export function computeResizeDimensions(
  source: Dimensions,
  maxLongEdgePx: number,
): Dimensions {
  if (!Number.isFinite(source.width) || source.width <= 0) {
    throw new RangeError(
      `computeResizeDimensions: source.width must be a positive finite number, got ${source.width}`,
    );
  }
  if (!Number.isFinite(source.height) || source.height <= 0) {
    throw new RangeError(
      `computeResizeDimensions: source.height must be a positive finite number, got ${source.height}`,
    );
  }
  if (!Number.isFinite(maxLongEdgePx) || maxLongEdgePx <= 0) {
    throw new RangeError(
      `computeResizeDimensions: maxLongEdgePx must be a positive finite number, got ${maxLongEdgePx}`,
    );
  }

  const longEdge = Math.max(source.width, source.height);
  if (longEdge <= maxLongEdgePx) {
    return { width: source.width, height: source.height };
  }

  const scale = maxLongEdgePx / longEdge;
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}
