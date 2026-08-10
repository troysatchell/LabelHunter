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
 * edge. Always returns a region with `x, y >= 0`, a positive width and
 * height, and `x + width <= imageWidth`, `y + height <= imageHeight` —
 * never throws, so a detector's slightly-off box degrades to the nearest
 * valid crop instead of failing the whole request.
 */
export function clampRegionToBounds(
  region: PixelRegion,
  imageWidth: number,
  imageHeight: number,
): PixelRegion {
  const left = Math.max(0, region.x);
  const top = Math.max(0, region.y);
  const right = Math.min(imageWidth, region.x + region.width);
  const bottom = Math.min(imageHeight, region.y + region.height);

  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  // The width/height floor of 1 above can push right/bottom past the image
  // edge when `region` falls entirely outside it — pull x/y back in to
  // compensate, rather than trust `left`/`top` unconditionally.
  const x = Math.min(left, Math.max(0, imageWidth - width));
  const y = Math.min(top, Math.max(0, imageHeight - height));

  return { x, y, width, height };
}
