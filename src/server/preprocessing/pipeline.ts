/**
 * Image preprocessing pipeline (TRO-460 / LH-010, PRD §3.1).
 *
 * Runs once per uploaded label image, before the Haiku extractor (PRD
 * §3.2, LH-011): rotate upright from EXIF, validate format and size,
 * produce the two vision variants the cascade needs, and expose a
 * warning-region crop hook for LH-020 to call later.
 *
 * Every output is JPEG (see `constants.ts` `OUTPUT_MEDIA_TYPE` for why) —
 * so any HEIC/PNG/WEBP source still hands the extractor a media type the
 * Claude vision API always accepts.
 */
import sharp from "sharp";
import type { Metadata as SharpMetadata } from "sharp";
import {
  HAIKU_MAX_LONG_EDGE_PX,
  MAX_INPUT_PIXELS,
  OUTPUT_MEDIA_TYPE,
  SONNET_MAX_LONG_EDGE_PX,
} from "./constants";
import { displayDimensions, type ExifOrientation } from "./exif";
import {
  ImageDimensionsTooLargeError,
  UnreadableImageError,
  UnsupportedFormatError,
} from "./errors";
import { clampRegionToBounds, type PixelRegion } from "./region";
import { computeResizeDimensions } from "./resize";
import { assertSupportedFormat, assertUploadSize } from "./validate";

export interface PreprocessImageOptions {
  /** Overrides `MAX_INPUT_PIXELS` — test-only hook to trigger the decompression-bomb guard on a small fixture. */
  readonly maxInputPixels?: number;
}

export interface PreprocessedImage {
  /** EXIF-rotated, full original resolution, re-encoded to JPEG. Reserved for OCR (a later ticket) — never discarded. */
  readonly original: Buffer;
  /** At most `HAIKU_MAX_LONG_EDGE_PX` on its long edge. Feeds the Haiku extractor. */
  readonly haikuVariant: Buffer;
  /** At most `SONNET_MAX_LONG_EDGE_PX` on its long edge. Reserved for the Sonnet resolver (LH-014) — not called by this ticket. */
  readonly sonnetVariant: Buffer;
  /** Pixel dimensions of `original`, after EXIF rotation. */
  readonly width: number;
  readonly height: number;
  readonly mediaType: typeof OUTPUT_MEDIA_TYPE;
}

/**
 * Classifies a sharp decode failure into one of this module's specific
 * error types, from the substring sharp puts in its error message. sharp
 * does not export typed error subclasses, so a message match is the only
 * signal available — verified against a live sharp run (see pipeline.test.ts).
 */
function classifyDecodeError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("exceeds pixel limit")) {
    return new ImageDimensionsTooLargeError();
  }
  if (message.includes("unsupported image format")) {
    return new UnsupportedFormatError(undefined);
  }
  return new UnreadableImageError(cause);
}

/**
 * Runs the full preprocessing pipeline on one uploaded image.
 *
 * Order matters: the byte-size check runs before any decode attempt, so an
 * oversized non-image buffer still fails fast and cheap with the right
 * error, never a decode attempt on 20+ MB of garbage.
 */
export async function preprocessImage(
  upload: Buffer,
  options: PreprocessImageOptions = {},
): Promise<PreprocessedImage> {
  assertUploadSize(upload.length);

  const maxInputPixels = options.maxInputPixels ?? MAX_INPUT_PIXELS;

  let metadata: SharpMetadata;
  try {
    metadata = await sharp(upload, { limitInputPixels: maxInputPixels }).metadata();
  } catch (cause) {
    throw classifyDecodeError(cause);
  }

  assertSupportedFormat(metadata.format);

  if (!metadata.width || !metadata.height) {
    throw new UnreadableImageError();
  }

  let original: Buffer;
  try {
    original = await sharp(upload, { limitInputPixels: maxInputPixels })
      // No-arg .rotate() auto-orients from the EXIF tag, bakes the rotation
      // into the pixel data, and strips the tag from the output — so a
      // viewer with no EXIF support still displays it upright.
      .rotate()
      // JPEG has no alpha channel. sharp's default matte for a dropped
      // alpha channel is BLACK, not white (confirmed empirically) — an
      // explicit white flatten avoids a transparent label graphic going
      // dark.
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  } catch (cause) {
    throw classifyDecodeError(cause);
  }

  const orientation = metadata.orientation as ExifOrientation | undefined;
  const { width, height } = displayDimensions(
    { width: metadata.width, height: metadata.height },
    orientation,
  );

  const haikuDims = computeResizeDimensions({ width, height }, HAIKU_MAX_LONG_EDGE_PX);
  const sonnetDims = computeResizeDimensions({ width, height }, SONNET_MAX_LONG_EDGE_PX);

  // Resize from `original` (already upright and full-resolution), not the
  // raw upload — avoids re-running EXIF rotation for every variant.
  const [haikuVariant, sonnetVariant] = await Promise.all([
    sharp(original)
      .resize(haikuDims.width, haikuDims.height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer(),
    sharp(original)
      .resize(sonnetDims.width, sonnetDims.height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 88 })
      .toBuffer(),
  ]);

  return {
    original,
    haikuVariant,
    sonnetVariant,
    width,
    height,
    mediaType: OUTPUT_MEDIA_TYPE,
  };
}

/**
 * Crops `region` out of `source` at native resolution. This is the
 * warning-region crop hook (PRD §3.1) — LH-020 (the warning subsystem)
 * calls this once it has located the warning block, passing
 * `preprocessedImage.original` as `source` so the crop is already upright
 * and at near-native DPI. This ticket does not detect the region; it only
 * guarantees the crop itself never fails on an out-of-bounds box (see
 * `region.ts`'s `clampRegionToBounds`).
 */
export async function cropRegion(
  source: Buffer,
  region: PixelRegion,
): Promise<Buffer> {
  let metadata: SharpMetadata;
  try {
    metadata = await sharp(source).metadata();
  } catch (cause) {
    throw classifyDecodeError(cause);
  }
  if (!metadata.width || !metadata.height) {
    throw new UnreadableImageError();
  }

  const clamped = clampRegionToBounds(region, metadata.width, metadata.height);

  try {
    return await sharp(source)
      .extract({
        left: clamped.x,
        top: clamped.y,
        width: clamped.width,
        height: clamped.height,
      })
      // Defensive, matching preprocessImage's `original` encode: `source`
      // is documented to be `original` (already alpha-free), but a crop
      // called on some other buffer with alpha must still avoid sharp's
      // default black matte.
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 95 })
      .toBuffer();
  } catch (cause) {
    throw classifyDecodeError(cause);
  }
}
