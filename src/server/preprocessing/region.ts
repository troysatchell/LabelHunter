/**
 * Warning-region crop hook — the pixel-math half (TRO-460 / LH-010, PRD
 * §3.1: "warning-region crop at near-native DPI").
 *
 * This ticket does not detect the warning block on a label — that is
 * LH-020's job (the warning subsystem, its own CP-2-gated component).
 * This file is the hook LH-020 calls once it has a region: given ANY
 * caller-supplied pixel box, guarantee it fits inside the image before
 * `pipeline.ts`'s `cropRegion` hands it to sharp's `.extract()`, which
 * throws on an out-of-bounds region instead of clamping it.
 */

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Clamps `region` to fit inside an image of `imageWidth` x `imageHeight` —
 * a rectangle intersection with `[0, imageWidth) x [0, imageHeight)`. A
 * region that overhangs one edge is truncated at that edge; a region that
 * falls entirely outside the image collapses to a 1x1 box at the nearest
 * edge. A fractional coordinate (a detector may report a bounding box in
 * floating-point) is rounded to the nearest whole pixel before clamping —
 * sharp's `.extract()` requires integers. Always returns a region with
 * `x, y >= 0`, a positive integer width and height, and
 * `x + width <= imageWidth`, `y + height <= imageHeight`.
 *
 * Never throws for a region that is merely out of bounds — a detector's
 * slightly-off box degrades to the nearest valid crop instead of failing
 * the whole request. DOES throw `RangeError` when a `region` field is
 * NaN or infinite: `Math.max`/`Math.min` silently propagate NaN rather
 * than clamping it, which would otherwise reach sharp's `.extract()` as
 * an invalid crop request with no clear error. A non-finite field is a
 * caller bug, not a detection imprecision, so it is rejected rather than
 * clamped.
 */
export function clampRegionToBounds(
  region: PixelRegion,
  imageWidth: number,
  imageHeight: number,
): PixelRegion {
  for (const key of ["x", "y", "width", "height"] as const) {
    if (!Number.isFinite(region[key])) {
      throw new RangeError(
        `clampRegionToBounds: region.${key} must be a finite number, got ${region[key]}`,
      );
    }
  }

  const x0 = Math.round(region.x);
  const y0 = Math.round(region.y);
  const width0 = Math.round(region.width);
  const height0 = Math.round(region.height);

  const left = Math.max(0, x0);
  const top = Math.max(0, y0);
  const right = Math.min(imageWidth, x0 + width0);
  const bottom = Math.min(imageHeight, y0 + height0);

  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  // The width/height floor of 1 above can push right/bottom past the image
  // edge when `region` falls entirely outside it — pull x/y back in to
  // compensate, rather than trust `left`/`top` unconditionally.
  const x = Math.min(left, Math.max(0, imageWidth - width));
  const y = Math.min(top, Math.max(0, imageHeight - height));

  return { x, y, width, height };
}
