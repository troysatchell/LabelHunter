/**
 * EXIF-orientation dimension logic (TRO-460 / LH-010, PRD §3.1: "EXIF
 * rotation"). Pure and deterministic — this file never decodes an image.
 *
 * A camera does not always rotate the pixels it stores; it often stores
 * them landscape and writes an EXIF `Orientation` tag (1-8) telling a
 * viewer how to rotate them for display. `sharp`'s `.metadata()` reports
 * the *stored* width/height plus that tag — the *displayed* dimensions
 * (after rotation) can have width and height swapped. This file computes
 * that swap without decoding pixels, confirmed against a live sharp
 * measurement in pipeline.test.ts.
 */
import type { Dimensions } from "./resize";

/** EXIF `Orientation` tag values, per the TIFF/EXIF spec. */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * True when `orientation` implies a 90deg or 270deg rotation for display —
 * the cases where displayed width/height are swapped from stored
 * width/height. Orientations 1-4 are upright or mirrored with no rotation;
 * 5-8 rotate a quarter turn.
 */
export function orientationSwapsDimensions(
  orientation: ExifOrientation,
): boolean {
  return orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
}

/**
 * Computes the dimensions an image displays at, given its stored
 * dimensions and EXIF orientation. `orientation` is `undefined` when the
 * file carries no orientation tag (already upright, or the format does not
 * support one) — treated the same as orientation 1.
 */
export function displayDimensions(
  stored: Dimensions,
  orientation: ExifOrientation | undefined,
): Dimensions {
  if (orientation !== undefined && orientationSwapsDimensions(orientation)) {
    return { width: stored.height, height: stored.width };
  }
  return stored;
}
