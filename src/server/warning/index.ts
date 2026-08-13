/**
 * The warning subsystem's public entry point (LH-020 / TRO-468, CP-2 §3–§8,
 * TH-R9). "Own component" (the ticket's own words): everything a future
 * caller needs to compare a label's government warning is exported from
 * here.
 *
 * Two ways in:
 *
 * - `reconcileWarningChannels` (re-exported from `reconcile.ts`) — pure,
 *   synchronous, no I/O. Takes an already-transcribed VLM reading and an
 *   already-OCR'd reading (or its absence) and returns a
 *   `WarningComparatorResult`. This is what the router's contract
 *   (`../router/types.ts`) actually needs, and what every test in this
 *   ticket exercises directly.
 * - `compareGovernmentWarningFromImage` (this file) — the async
 *   convenience that a route handler calls with a real image: runs region
 *   detection, crops, OCRs, and calls `reconcileWarningChannels`. Wired
 *   into `src/app/api/verify/route.ts` (TRO-514, that file's own header
 *   comment) — every `POST /api/verify` now calls it, confirmed live by
 *   TRO-519's own repro run (see that ticket's PR body).
 *
 * PRD §3.8 / CP-2 §4.4: OCR must run CONCURRENTLY with the Haiku call,
 * never after it. `compareGovernmentWarningFromImage` accepts the VLM
 * reading as a `Promise` for exactly this reason — `Promise.all` below
 * starts region detection and OCR in the same tick it starts awaiting the
 * VLM promise, so a caller who passes `extractLabel(...).then(r =>
 * r.government_warning)` gets true concurrency without this module ever
 * calling a model itself (this ticket's comparator calls no model — it
 * consumes the transcription the extractor already produced).
 */
import type { ExtractedGovernmentWarning } from "../extractor/types";
import { cropForOcr, detectWarningRegion } from "./region-detect";
import { runWarningOcr } from "./ocr";
import {
  reconcileWarningChannels,
  type OcrChannelInput,
  type VlmWarningCandidate,
} from "./reconcile";
import type { WarningComparatorResult } from "../router/types";

export type { CandidateEvaluation, WordingClassification } from "./wording-compare";
export { evaluateCandidate, isExactMatch, NEAR_MISS_MAX_DISTANCE } from "./wording-compare";
export type { CapPositionStatus, CapsCheckResult } from "./caps";
export { capsCheckPasses, capsResultsEqual, checkCapitalPositions, hasAnyCapsFailure, isPrefixAllCaps } from "./caps";
export { foldCase, normalizeTransport } from "./normalize";
export { CANONICAL_WARNING_PARAGRAPHS, CANONICAL_WARNING_TEXT, CHECKED_CAPITALIZATION_WORDS } from "./canonical";
export {
  OCR_CONFIDENCE_FLOOR,
  reconcileWarningChannels,
  SINGLE_CHANNEL_PASS_CONFIDENCE,
  type OcrChannelInput,
  type VlmWarningCandidate,
} from "./reconcile";
export {
  OCR_PAGE_SEGMENTATION_MODE,
  OCR_TIMEOUT_MS,
  runWarningOcr,
  TESSDATA_DIR,
  TESSDATA_LANGUAGE_FILE,
  type OcrWarningResult,
  type RunWarningOcrDeps,
} from "./ocr";
export {
  cropForOcr,
  detectWarningRegion,
  detectWarningRegionByBandSearch,
  detectWarningRegionClassical,
  type WarningRegionDetectionResult,
} from "./region-detect";

/**
 * Converts the extractor's raw field into this module's stricter input
 * shape. Returns `null` when there is no transcription to compare —
 * `null` on `ExtractedGovernmentWarning.transcription` is the router's
 * `MISSING_REQUIRED_FIELD` territory (`../router/field-resolution.ts`'s
 * `resolveGovernmentWarningField`), which already runs before a caller
 * would reach this comparator. This function is a defensive boundary
 * check (standing rule 13), not the primary way absence gets handled.
 */
export function toVlmWarningCandidate(extracted: ExtractedGovernmentWarning): VlmWarningCandidate | null {
  if (extracted.transcription === null) return null;
  return {
    transcription: extracted.transcription,
    prefixCasing: extracted.prefix_casing,
    confidence: extracted.confidence,
  };
}

/** The pieces `compareGovernmentWarningFromImage` calls — injectable so a
 * caller (or a test) can supply fakes with controlled timing, the same
 * dependency-injection shape `src/app/api/verify/route.ts`'s
 * `VerifyRouteDeps` uses. */
export interface CompareGovernmentWarningFromImageDeps {
  detectRegion: typeof detectWarningRegion;
  crop: typeof cropForOcr;
  ocr: typeof runWarningOcr;
}

const defaultDeps: CompareGovernmentWarningFromImageDeps = {
  detectRegion: detectWarningRegion,
  crop: cropForOcr,
  ocr: runWarningOcr,
};

export interface CompareGovernmentWarningFromImageInput {
  /** The extractor's government_warning field, or a promise for it — pass
   * a promise (e.g. `extractLabel(image).then(r => r.government_warning)`)
   * to get real concurrency with the Haiku call, per this file's header
   * comment. */
  extracted: ExtractedGovernmentWarning | Promise<ExtractedGovernmentWarning>;
  /** The ORIGINAL, full-resolution preprocessed image — never the resized
   * Haiku/Sonnet variant (CP-2 §8.3's DPI math: the resized variant falls
   * below Tesseract's usable x-height floor at the statute's legal minimum
   * print size). */
  originalImage: Buffer;
}

/** Runs region detection, crops, and OCRs — the OCR "channel" half of the
 * comparison. Never throws. `detectWarningRegion` returning `null`, or
 * `ocr` returning `null`, both degrade this function to
 * `{ available: false }`, which `reconcileWarningChannels` already treats
 * as "run single-channel" (CP-2 §4.4 rule 3: a crashed OR hung OCR path
 * must never fail the request).
 *
 * **The precise bound, named exactly (local CodeRabbit review round 1
 * corrected an earlier overclaim here).** Each individual `ocr` call
 * (`deps.ocr`, `runWarningOcr` in production) is bounded by its own
 * `OCR_TIMEOUT_MS` deadline and degrades to `null` on a throw OR a
 * timeout (TRO-519). That is a bound on ONE call, not yet on this whole
 * function: `detectWarningRegion`'s band-search fallback can call `ocr`
 * up to four times in one request (`region-detect.ts`, out of TRO-519's
 * file scope), and `deps.detectRegion`/`deps.crop` themselves — the
 * classical-detection and crop `sharp` calls — carry no deadline of
 * their own at all. `ocr.ts`'s own `OCR_TIMEOUT_MS` comment names this
 * gap and the follow-up ticket it would take to close it.
 *
 * The outer `try`/`catch` here covers a REJECTED promise, not just a
 * resolved `null` — `deps.detectRegion`/`deps.crop` are not guaranteed to
 * catch their own errors the way `runWarningOcr` now does, and an
 * uncaught rejection here would otherwise reject the `Promise.all` this
 * function is one half of, taking the VLM channel's already-good result
 * down with it. */
async function runOcrChannel(
  originalImage: Buffer,
  deps: CompareGovernmentWarningFromImageDeps,
): Promise<OcrChannelInput> {
  try {
    const detection = await deps.detectRegion(originalImage, (crop) => deps.ocr(crop));
    if (!detection) return { available: false };

    const crop = await deps.crop(originalImage, detection.region);
    const result = await deps.ocr(crop);
    if (!result) return { available: false };
    return { available: true, text: result.text, confidence: result.confidence };
  } catch {
    return { available: false };
  }
}

/**
 * The full CP-2 §3–§8 pipeline against a real image: detects the warning
 * region, crops it (PNG, never JPEG — `region-detect.ts`'s `cropForOcr`),
 * OCRs it, and reconciles that against the VLM's own transcription. Runs
 * the OCR path and the (possibly still-pending) VLM promise concurrently.
 */
export async function compareGovernmentWarningFromImage(
  input: CompareGovernmentWarningFromImageInput,
  deps: CompareGovernmentWarningFromImageDeps = defaultDeps,
): Promise<WarningComparatorResult> {
  const extractedPromise = Promise.resolve(input.extracted);
  const ocrChannelPromise = runOcrChannel(input.originalImage, deps);

  const [extracted, ocrChannel] = await Promise.all([extractedPromise, ocrChannelPromise]);

  const vlm = toVlmWarningCandidate(extracted);
  if (!vlm) {
    // Defensive only — see toVlmWarningCandidate's own comment. A real
    // caller filters this case out before reaching here.
    return { verdict: "NEEDS_REVIEW", reviewReason: "MISSING_REQUIRED_FIELD" };
  }

  return reconcileWarningChannels(vlm, ocrChannel);
}
