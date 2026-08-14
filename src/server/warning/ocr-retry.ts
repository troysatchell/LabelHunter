/**
 * OCR channel retry (TRO-583, TH-R9/TH-R17/TH-R2). Troy's escalation
 * philosophy for this ticket: "if it doesn't know it should pass it on to
 * the next tier." A bad OCR READING needs a better read, not a smarter
 * judge — the Sonnet resolver stays structurally forbidden from ruling on
 * the warning (CP-1, `resolver/schema.ts`), so the honest costlier tier
 * here is one retried Tesseract pass on an alternate preprocessing
 * variant of the SAME crop, not an escalation to a model.
 *
 * Two pure pieces, each independently testable without a real OCR call:
 *
 * - `shouldRetryOcr` decides WHETHER the OCR channel's first attempt
 *   counts as a failure worth retrying.
 * - `buildOcrRetryVariant` decides WHAT to try differently: an upscaled
 *   copy of the same crop.
 *
 * `index.ts`'s `runOcrChannel` is the only caller — it fires this ONLY on
 * the failure path (this file's own header comment on each function names
 * the exact trigger), so the happy path (a usable first read) never
 * touches either function, and is byte-identical to the pre-TRO-583 code
 * (`index.test.ts`'s "does not touch the retry path on a successful first
 * read" test proves this).
 */
import sharp from "sharp";
import type { OcrWarningResult } from "./ocr";
import { OCR_CONFIDENCE_FLOOR } from "./reconcile";

/**
 * How much to enlarge the crop on retry, applied to both dimensions.
 *
 * **Why upscale, not threshold (the ticket's other named example).** The
 * corpus's own measured OCR failure mode that already forces single-channel
 * degradation is tiny print, not poor contrast: `reconcile.ts`'s
 * `OCR_CONFIDENCE_FLOOR` comment names case-23/24 ("tiny warning print") as
 * the two golden-set cases whose confidence (56, 58) sits in the failure
 * range, reading text 42-47 edits from canonical — a resolution problem,
 * not a lighting one. Case-22's lighting problem (the OTHER named failure
 * mode in this codebase, TRO-546's `DARK_RATIO`/`BACKGROUND_PERCENTILE`
 * comments) is already handled upstream, inside region DETECTION itself
 * (a per-row background estimate), before a crop like this one is even
 * produced — thresholding the crop a second time here would fight that
 * already-tuned per-row estimate instead of complementing it. Upscaling
 * has no such interaction: it only adds pixels for Tesseract's LSTM engine
 * to resolve small glyphs against, which is the textbook remedy for
 * exactly the low-resolution failure this corpus has already measured.
 *
 * 2x, not a larger factor: `ocr.ts`'s `OCR_TIMEOUT_MS` comment reasons the
 * whole OCR channel budget from PRD §3.8's latency target, and a bigger
 * upscale costs more of that budget for recognition on a still-bounded
 * retry (see `OCR_TIMEOUT_MS` — this retry inherits that SAME per-call
 * bound, not a larger one). 2x is the smallest doubling that meaningfully
 * raises a tiny-print crop's effective resolution.
 */
export const OCR_RETRY_UPSCALE_FACTOR = 2;

/**
 * Whether `result` — the OCR channel's FIRST attempt — counts as a failure
 * the retry should fire for. Mirrors `reconcile.ts`'s own usability test
 * (`ocr.available && ocr.confidence >= OCR_CONFIDENCE_FLOOR`) exactly, by
 * importing the SAME constant, so "a read that would force single-channel
 * degradation" here means the identical thing it means there — never a
 * second, independently-chosen number.
 *
 * `null` covers both of `runWarningOcr`'s degraded outcomes (TRO-519): a
 * thrown error and a timeout collapse to the same value by that module's
 * own contract, so this function does not need to (and cannot) tell them
 * apart — both are "no usable reading," which is exactly the failure this
 * ticket retries.
 */
export function shouldRetryOcr(result: OcrWarningResult | null): boolean {
  if (result === null) return true;
  return result.confidence < OCR_CONFIDENCE_FLOOR;
}

/**
 * Builds the ONE alternate-preprocessing variant `index.ts` retries OCR
 * with — an `OCR_RETRY_UPSCALE_FACTOR`x enlargement of `crop`, re-encoded
 * as PNG to match `region-detect.ts`'s `cropForOcr` (never JPEG — CP-2
 * §8.3's own reasoning: a lossy round trip would add compression artifacts
 * to exactly the small print this channel exists to read).
 *
 * Never throws. A crop `sharp` cannot read its own dimensions from
 * (defensive only — `cropForOcr` already guarantees a real crop in
 * production) degrades to returning `crop` UNCHANGED, so the caller's
 * retry attempt runs real OCR against the same bytes and fails the same
 * way the first attempt did — no different, and no worse, than skipping
 * the retry outright.
 */
export async function buildOcrRetryVariant(crop: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(crop).metadata();
    if (!metadata.width || !metadata.height) return crop;
    return await sharp(crop)
      .resize(
        Math.round(metadata.width * OCR_RETRY_UPSCALE_FACTOR),
        Math.round(metadata.height * OCR_RETRY_UPSCALE_FACTOR),
      )
      .png()
      .toBuffer();
  } catch {
    return crop;
  }
}
