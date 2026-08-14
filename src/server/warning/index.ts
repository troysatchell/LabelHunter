/**
 * The warning subsystem's public entry point (CP-2 §3–§8, TH-R9).
 *
 * Two ways in:
 *
 * - `reconcileWarningChannels` — pure and synchronous. It takes a vision
 *   reading and an OCR reading and returns a `WarningComparatorResult`.
 * - `compareGovernmentWarningFromImage` — the async wrapper a route calls
 *   with a real image. It detects the region, crops, OCRs, then reconciles.
 *
 * It takes the vision reading as a `Promise`, never an awaited value, so
 * region detection and OCR run beside the Haiku call (CP-2 §4.4). This
 * module calls no model itself.
 *
 * The bold signal sits in `.boldSignal`, beside `.comparator`, never inside
 * it. That split makes the CP-2 §7.2 boundary a type error to violate: bold
 * can never join the comparator's own MATCH/MISMATCH decision. The router
 * reads `.boldSignal.signal` separately and degrades an otherwise-MATCH
 * warning to NEEDS_REVIEW on `not-bold`. It can never make that a MISMATCH.
 */
import type { ExtractedGovernmentWarning } from "../extractor/types";
import { cropForOcr, detectWarningRegion } from "./region-detect";
import { OCR_TIMEOUT_MS, runWarningOcr, type OcrWarningResult } from "./ocr";
import { buildOcrRetryVariant, shouldRetryOcr } from "./ocr-retry";
import { measureBoldSignal, type BoldSignalResult } from "./bold-detect";
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
export { buildOcrRetryVariant, OCR_RETRY_UPSCALE_FACTOR, shouldRetryOcr } from "./ocr-retry";
export {
  cropForOcr,
  detectWarningRegion,
  detectWarningRegionByBandSearch,
  detectWarningRegionClassical,
  type WarningRegionDetectionResult,
} from "./region-detect";
export {
  BOLD_RATIO_THRESHOLD,
  classifyBoldSignal,
  measureBoldSignal,
  STROKE_WIDTH_FLOOR_PX,
  type BoldSignal,
  type BoldSignalResult,
} from "./bold-detect";

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
  /** LH-025/LH-026 (TRO-532/TRO-533) — measures the bold advisory signal
   * off the SAME crop `ocr` reads. Injectable for the same reason every
   * other dependency here is: a test can supply a fake with a controlled
   * result. */
  measureBoldSignal: typeof measureBoldSignal;
  /** TRO-583 — builds the ONE alternate-preprocessing variant `runOcrChannel`
   * retries a failed first OCR attempt with. Injectable for the same
   * reason every other dependency here is: a test can supply a fake that
   * returns a distinguishable buffer, to prove the retry's OWN read (not
   * the first attempt's) reaches `ocr`. */
  buildRetryVariant: typeof buildOcrRetryVariant;
}

const defaultDeps: CompareGovernmentWarningFromImageDeps = {
  detectRegion: detectWarningRegion,
  crop: cropForOcr,
  ocr: runWarningOcr,
  measureBoldSignal,
  buildRetryVariant: buildOcrRetryVariant,
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

/** The OCR half of the comparison: detect the region, crop, then OCR.
 *
 * It never throws. A `null` from either step degrades the channel to
 * `{ available: false }`, which reconciliation reads as "run single
 * channel" (CP-2 §4.4 rule 3: a crashed or hung OCR never fails the
 * request). The outer catch covers a rejected promise too — an uncaught
 * rejection here would take the vision channel's good result down with it.
 *
 * **The deadline is per call, not per function.** Each `ocr` call carries
 * its own `OCR_TIMEOUT_MS`. Region detection can call `ocr` up to four
 * times, and `detectRegion`/`crop` carry no deadline at all. `ocr.ts`
 * names that gap.
 *
 * The bold signal is measured as soon as the crop exists. It needs no
 * transcription, so it does not wait on OCR. It stays `null` when region
 * detection found nothing — a distinct state from a measured "uncertain".
 *
 * **The retry.** A bad reading needs a better read, not a smarter judge:
 * the Sonnet resolver stays forbidden from ruling on the warning (CP-1).
 * `shouldRetryOcr` fires at most once, on a `null` or a confidence below
 * `OCR_CONFIDENCE_FLOOR`, against the same crop. `runRetryPhaseWithDeadline`
 * races the variant build and the second OCR against one `OCR_TIMEOUT_MS`,
 * so the channel's worst case is exactly `2 * OCR_TIMEOUT_MS`. A failed
 * retry falls back to the first attempt's own result. */
async function runOcrChannel(
  originalImage: Buffer,
  deps: CompareGovernmentWarningFromImageDeps,
): Promise<{ ocrChannel: OcrChannelInput; boldSignal: BoldSignalResult | null }> {
  try {
    const detection = await deps.detectRegion(originalImage, (crop) => deps.ocr(crop));
    if (!detection) return { ocrChannel: { available: false }, boldSignal: null };

    const crop = await deps.crop(originalImage, detection.region);
    const boldSignal = await deps.measureBoldSignal(crop).catch(() => null);

    const firstResult = await deps.ocr(crop);

    let result: OcrWarningResult | null = firstResult;
    if (shouldRetryOcr(firstResult)) {
      const retryOutcome = await runRetryPhaseWithDeadline(crop, deps);
      if (retryOutcome !== RETRY_PHASE_TIMED_OUT) {
        result = retryOutcome ?? firstResult;
      }
      // else: the retry phase itself (variant build + retry OCR) hung
      // past OCR_TIMEOUT_MS — abandon it, keep the first attempt's own
      // (already-failed) result. "Never an unbounded hang."
    }

    if (!result) return { ocrChannel: { available: false }, boldSignal };
    return { ocrChannel: { available: true, text: result.text, confidence: result.confidence }, boldSignal };
  } catch {
    return { ocrChannel: { available: false }, boldSignal: null };
  }
}

/** A `Symbol`, not `null`/`undefined`, so it can never collide with a
 * genuine `OcrWarningResult | null` outcome from the retry phase itself —
 * mirrors `ocr.ts`'s own `OCR_TIMED_OUT` sentinel pattern (TRO-519). */
const RETRY_PHASE_TIMED_OUT = Symbol("OCR retry phase timed out");

/**
 * Runs `deps.buildRetryVariant(crop)` THEN `deps.ocr(variant)` against one
 * shared `OCR_TIMEOUT_MS` deadline (TRO-583, local CodeRabbit review round
 * 1) — see `runOcrChannel`'s own header comment for why this exists and
 * why it is ONE timer, not two nested ones (lessons.md rule 23).
 *
 * The retry-phase promise is wrapped in `.catch(() => null)` so it can
 * NEVER reject — matching this file's own `measureBoldSignal(...).catch(()
 * => null)` precedent for the same reason: `deps.buildRetryVariant`/
 * `deps.ocr` are injectable, so a test double's failure mode is not
 * guaranteed the way the real, contract-abiding implementations' are
 * (standing rule 13). Without this, a late rejection on the LOSING side of
 * `Promise.race` (below) — the retry phase rejecting AFTER the deadline
 * already won — would be an unhandled rejection nobody observes.
 *
 * If the deadline wins, the retry phase keeps running in the background,
 * unawaited — the same "never block on the loser" rule `runWarningOcr`
 * itself already follows (TRO-519) — but `deps.ocr`'s own production
 * implementation (`runWarningOcr`) always terminates its own worker
 * regardless of whether anyone is still awaiting it, so this leaves
 * nothing running that would not have cleaned up on its own.
 */
async function runRetryPhaseWithDeadline(
  crop: Buffer,
  deps: CompareGovernmentWarningFromImageDeps,
): Promise<OcrWarningResult | null | typeof RETRY_PHASE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof RETRY_PHASE_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(RETRY_PHASE_TIMED_OUT), OCR_TIMEOUT_MS);
  });
  const retryPhase: Promise<OcrWarningResult | null> = (async () => {
    const retryVariant = await deps.buildRetryVariant(crop);
    return deps.ocr(retryVariant);
  })().catch(() => null);

  try {
    return await Promise.race([retryPhase, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `compareGovernmentWarningFromImage`'s return value: the router-facing
 * comparison result, PLUS the bold advisory signal measured off the same
 * crop — kept as two separate fields, never merged into one shape, so the
 * type system itself keeps the bold signal off `routeLabel`'s only input
 * from this module (this file's header comment; standing rule 10).
 */
export interface CompareGovernmentWarningFromImageResult {
  /** The router's only input from this module. Never attach `boldSignal`
   * (or anything else) onto this object — pass it as a sibling field on
   * this result instead. */
  comparator: WarningComparatorResult;
  /** LH-025's advisory signal (TRO-532/TRO-533), measured from the SAME
   * crop the OCR channel used, whenever region detection found one. `null`
   * when no crop was ever produced — distinct from a measured
   * `signal: "uncertain"`, which means a crop existed but the measurement
   * itself could not commit to bold or not-bold. Callers persist and
   * display this value, and pass `.signal` to `routeLabel` as its
   * `warningBoldSignal` parameter (TRO-569): the router degrades an
   * otherwise-MATCH warning to NEEDS_REVIEW on `not-bold`, and nothing
   * else. The comparator itself never reads it, and it can never produce
   * a hard FAIL. */
  boldSignal: BoldSignalResult | null;
}

/**
 * The full CP-2 §3–§8 pipeline against a real image: detects the warning
 * region, crops it (PNG, never JPEG — `region-detect.ts`'s `cropForOcr`),
 * OCRs it, measures the bold advisory signal off the same crop, and
 * reconciles the OCR/VLM channels against each other. Runs the OCR path
 * and the (possibly still-pending) VLM promise concurrently.
 */
export async function compareGovernmentWarningFromImage(
  input: CompareGovernmentWarningFromImageInput,
  deps: CompareGovernmentWarningFromImageDeps = defaultDeps,
): Promise<CompareGovernmentWarningFromImageResult> {
  const extractedPromise = Promise.resolve(input.extracted);
  const ocrChannelPromise = runOcrChannel(input.originalImage, deps);

  const [extracted, { ocrChannel, boldSignal }] = await Promise.all([extractedPromise, ocrChannelPromise]);

  const vlm = toVlmWarningCandidate(extracted);
  if (!vlm) {
    // Defensive only — see toVlmWarningCandidate's own comment. A real
    // caller filters this case out before reaching here.
    return { comparator: { verdict: "NEEDS_REVIEW", reviewReason: "MISSING_REQUIRED_FIELD" }, boldSignal };
  }

  return { comparator: reconcileWarningChannels(vlm, ocrChannel), boldSignal };
}
