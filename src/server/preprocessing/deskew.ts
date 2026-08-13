/**
 * Skew estimation (TRO-540 / LH-035).
 *
 * `preprocessImage`'s `.rotate()` call (`pipeline.ts`) corrects orientation
 * from the EXIF tag only, by design (PRD §3.1). A tilt baked into the
 * pixels at capture time — the photographer held the camera at an angle —
 * writes no EXIF orientation tag, so that call does nothing to it. Both
 * the Haiku extractor and the classical warning-region detector
 * (`../warning/region-detect.ts`) then read a tilted image. Measured on
 * golden-set case-19: a 15-degree baked-in rotation, no EXIF block at
 * all, and `detectWarningRegionClassical` returns `null` against it.
 *
 * This module only measures the tilt. `pipeline.ts` does the correction,
 * by feeding this module's estimate into a second `sharp().rotate()`
 * pass.
 *
 * Method: a row-ink projection, the same technique `region-detect.ts`
 * uses to find the warning block, run here as an angle sweep instead of a
 * block search. For each candidate angle, rotate the (downscaled)
 * analysis image by that angle and count ink pixels per row. At the
 * correct angle, real text rows are horizontal — dense ink on a line,
 * near-empty in the gap before the next one — so that angle's row-ink
 * profile has a sharp, isolated peak in its variance across rows. An
 * angle even a little off blurs adjacent rows together and flattens it.
 *
 * The peak must be a **local** one — strictly higher than both
 * immediate neighbors in the sweep, not just the highest value seen. A
 * large flat block of one color (no text at all) is the case this
 * distinction exists for: rotating a solid rectangle against a white
 * background changes row-ink coverage smoothly and monotonically as the
 * angle grows (the rotated corners eat further into the edge rows at
 * every step) — never a peak, since a monotonic curve has no point where
 * both neighbors score lower. `pipeline.test.ts`'s own EXIF-rotation
 * fixtures are exactly this shape (a single flat fill), so this
 * distinction is what keeps their post-rotation width/height assertions
 * unchanged (see `deskew.test.ts`'s equivalent fixture for the direct
 * proof).
 */
import sharp from "sharp";
import type { Metadata as SharpMetadata } from "sharp";
import { MAX_DESKEW_ANGLE_DEG } from "./constants";

/**
 * Downscale target for the row-ink projection. Copied from
 * `region-detect.ts`'s module-private `ANALYSIS_WIDTH_PX` (same value,
 * same reasoning: large enough to resolve individual text rows, small
 * enough to run fast) — that constant is module-private there by design,
 * so this is a deliberate, named copy, not a shared binding.
 */
const ANALYSIS_WIDTH_PX = 500;

/**
 * A pixel counts as "ink" when it is darker than this fixed grey value.
 * Copied from `region-detect.ts`'s original absolute rule ("below 180 on
 * a 0-255 scale"; see that file's `DARK_RATIO` comment for why the region
 * detector itself later moved to a per-row relative threshold to survive
 * an unevenly lit photo). That failure mode does not apply here: one
 * sweep always compares an image against rotated copies of itself, so a
 * uniform light source affects every candidate angle the same way.
 */
const DARK_PIXEL_THRESHOLD = 180;

/**
 * Degree step for the angle sweep. 1 degree keeps the worst-case
 * discretization error (0.5 degree, half a step) well inside the
 * 2-degree tolerance the acceptance evidence sets, at half the `sharp`
 * calls a 0.5-degree step would need.
 */
const ANGLE_STEP_DEG = 1;

/**
 * A candidate peak's variance must clear this floor before it counts as
 * "clear" — guards the local-peak check above against selecting a bump
 * that is only floating-point noise on an otherwise flat curve. Proposed,
 * not measured: every real peak seen while building this module (the
 * 15-degree fixture, case-19 itself) cleared it by at least two orders of
 * magnitude, but no sweep across the full golden set has tuned this
 * value.
 */
const MIN_PEAK_VARIANCE = 1e-6;

/** Population variance of a numeric array. Assumes `values` is non-empty
 * — every caller in this file only ever passes one row-ink-fraction
 * array per candidate angle, which always has at least one row. */
function variance(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

/**
 * Row-ink-projection variance for one candidate rotation angle. Rotates
 * the (already downscaled) analysis image by `angleDeg` using the same
 * `sharp().rotate()` call `pipeline.ts` uses for the real correction pass
 * — so the sweep measures the exact operation it is choosing an angle
 * for — then counts the ink fraction of every row of the rotated result.
 */
async function rowInkVarianceAtAngle(analysisImage: Buffer, angleDeg: number): Promise<number> {
  const { data, info } = await sharp(analysisImage)
    .rotate(angleDeg, { background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rowInkFractions: number[] = [];
  for (let y = 0; y < info.height; y++) {
    let dark = 0;
    const rowStart = y * info.width;
    for (let x = 0; x < info.width; x++) {
      if (data[rowStart + x] < DARK_PIXEL_THRESHOLD) dark++;
    }
    rowInkFractions.push(dark / info.width);
  }
  return variance(rowInkFractions);
}

/**
 * Estimates the angle, in degrees and in `sharp().rotate()`'s own
 * convention, that straightens a baked-in tilt in `image`. Feed the
 * return value directly into `sharp(buffer).rotate(angle)` — no sign
 * flip needed.
 *
 * Returns 0 when the sweep finds no clear peak: an unreadable image, a
 * blank/flat one, or a large flat block of one color — none of which is
 * text, so 0 (no correction) is the honest answer, not a guess.
 */
export async function estimateSkewAngleDeg(image: Buffer): Promise<number> {
  let metadata: SharpMetadata;
  try {
    metadata = await sharp(image).metadata();
  } catch {
    return 0;
  }
  if (!metadata.width || !metadata.height) return 0;

  let analysisImage: Buffer;
  try {
    const scale = ANALYSIS_WIDTH_PX / metadata.width;
    const analysisHeight = Math.max(1, Math.round(metadata.height * scale));
    analysisImage = await sharp(image).resize(ANALYSIS_WIDTH_PX, analysisHeight, { fit: "fill" }).toBuffer();
  } catch {
    return 0;
  }

  const angles: number[] = [];
  for (let a = -MAX_DESKEW_ANGLE_DEG; a <= MAX_DESKEW_ANGLE_DEG; a += ANGLE_STEP_DEG) {
    angles.push(a);
  }

  const variances = await Promise.all(
    angles.map((angleDeg) => rowInkVarianceAtAngle(analysisImage, angleDeg)),
  );

  // A candidate counts as the answer only when it beats BOTH immediate
  // neighbors in the sweep — see this file's header comment for why that
  // (not the raw maximum) is the check that rejects a solid-color block.
  let bestIndex = -1;
  let bestVariance = MIN_PEAK_VARIANCE;
  for (let i = 1; i < angles.length - 1; i++) {
    const v = variances[i];
    if (v > variances[i - 1] && v > variances[i + 1] && v > bestVariance) {
      bestVariance = v;
      bestIndex = i;
    }
  }

  return bestIndex === -1 ? 0 : angles[bestIndex];
}
