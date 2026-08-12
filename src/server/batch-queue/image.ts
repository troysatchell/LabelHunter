/**
 * Rebuilds a Haiku or Sonnet vision variant from a stored label image
 * (LH-041 / TRO-474, CP-3 §2.3).
 *
 * Batch queue items do not carry a preprocessed image buffer — only
 * `label_images.storage_path` (the EXIF-rotated, full-resolution `original`
 * `../preprocessing/pipeline.ts`'s `preprocessImage` already produced and
 * `saveLabelImage` already wrote to disk, the same buffer
 * `src/app/api/verify/route.ts` saves for the single-label path). A queued
 * item can sit for as long as the batch takes to drain, so re-deriving the
 * small, per-call vision variant on demand — a resize, never a second model
 * call (CP-3 §2.3) — is cheaper and simpler than storing every variant a
 * label might ever need.
 *
 * This mirrors `../preprocessing/pipeline.ts`'s own `haikuVariant`/
 * `sonnetVariant` computation exactly (same dimensions math, same JPEG
 * quality settings) without importing from it — that module's
 * `preprocessImage` takes a raw upload and re-does EXIF rotation/format
 * detection, work already done once by whoever saved `original`.
 */
import sharp from "sharp";
import { computeResizeDimensions, HAIKU_MAX_LONG_EDGE_PX, SONNET_MAX_LONG_EDGE_PX } from "../preprocessing";

async function resizeTo(original: Buffer, width: number, height: number, maxLongEdgePx: number, jpegQuality: number): Promise<Buffer> {
  const dims = computeResizeDimensions({ width, height }, maxLongEdgePx);
  return sharp(original)
    .resize(dims.width, dims.height, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: jpegQuality })
    .toBuffer();
}

/** At most `HAIKU_MAX_LONG_EDGE_PX` on its long edge — matches
 * `preprocessImage`'s own `haikuVariant` quality (85). `width`/`height` are
 * `original`'s own dimensions (`label_images.widthPx`/`heightPx`), not
 * re-measured here — the caller already has them from the database row. */
export async function resizeStoredOriginalToHaikuVariant(original: Buffer, width: number, height: number): Promise<Buffer> {
  return resizeTo(original, width, height, HAIKU_MAX_LONG_EDGE_PX, 85);
}

/** At most `SONNET_MAX_LONG_EDGE_PX` on its long edge — matches
 * `preprocessImage`'s own `sonnetVariant` quality (88). */
export async function resizeStoredOriginalToSonnetVariant(original: Buffer, width: number, height: number): Promise<Buffer> {
  return resizeTo(original, width, height, SONNET_MAX_LONG_EDGE_PX, 88);
}
