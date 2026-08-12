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
 *   detection, crops, OCRs, and calls `reconcileWarningChannels`. Not
 *   wired into `src/app/api/verify/route.ts` by this ticket (that route
 *   currently passes `warningResult: null` on purpose, per its own file
 *   comment) — see this ticket's final report for why that wiring is left
 *   to a follow-up rather than folded in here.
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
export { OCR_PAGE_SEGMENTATION_MODE, runWarningOcr, TESSDATA_DIR, TESSDATA_LANGUAGE_FILE, type OcrWarningResult } from "./ocr";
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
 * comparison. Never throws: `detectWarningRegion` returning `null`, or
 * `ocr` returning `null`, both degrade to `{ available: false }`, which
 * `reconcileWarningChannels` already treats as "run single-channel" (CP-2
 * §4.4 rule 3: a crashed OCR path must never fail the request). The outer
 * `try`/`catch` covers the same rule for a REJECTED promise, not just a
 * resolved `null` — `ocr.ts`'s `runWarningOcr` already catches its own
 * errors, but `deps.detectRegion`/`deps.crop` (sharp calls against a
 * caller-supplied buffer) are not guaranteed to, and an uncaught
 * rejection here would otherwise reject the `Promise.all` this function
 * is one half of, taking the VLM channel's already-good result down with
 * it. */
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
