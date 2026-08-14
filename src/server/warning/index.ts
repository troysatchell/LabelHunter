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
 *
 * **The bold advisory signal (LH-025/LH-026/TRO-569, TRO-532/TRO-533, CP-2
 * §7.2/§7.3, TH-R9).** `compareGovernmentWarningFromImage` also measures
 * `measureBoldSignal` (`./bold-detect`) against the SAME crop
 * `runOcrChannel` already produces for OCR — no second region detection,
 * no second crop. The result travels in `CompareGovernmentWarningFromImageResult
 * .boldSignal`, a field that sits BESIDE `.comparator`, never inside it.
 * `bold-detect.ts`'s own header comment states the boundary this split
 * still guarantees: the signal must never produce a hard FAIL by itself.
 * Keeping it off `WarningComparatorResult` makes THAT guarantee a type
 * error to violate, not just a rule to remember (standing rule 10) — a
 * `not-bold` signal can never, by construction, become part of the
 * comparator's own MATCH/MISMATCH decision.
 *
 * TRO-569 narrows the OTHER half of the old rule ("must never gate a
 * MATCH"): `.boldSignal.signal` now ALSO reaches `routeLabel`, as its own
 * separate, optional parameter — `WarningComparatorResult` still carries
 * nothing about bold. The router (`../router/field-resolution.ts`)
 * degrades an otherwise-MATCH warning to `NEEDS_REVIEW` on a `not-bold`
 * signal; it can still never turn one into a MISMATCH.
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
 * down with it.
 *
 * **Bold signal (TRO-533).** Measured right after the crop exists, before
 * `deps.ocr` even runs — the bold signal needs only the crop, not a
 * transcription, so it does not wait on OCR to finish. `deps.measureBoldSignal`
 * never throws by its own contract (`bold-detect.ts`'s header comment),
 * but an INJECTED implementation's failure mode is not guaranteed
 * (standing rule 13), so `.catch(() => null)` is this function's own
 * boundary check, not a trust in that contract. `boldSignal` stays `null`
 * whenever no crop was ever produced (region detection found nothing) —
 * a state distinct from a measured `signal: "uncertain"`.
 *
 * **The retry (TRO-583).** Troy's escalation rule for this ticket: "if it
 * doesn't know it should pass it on to the next tier." A bad READING
 * needs a better read, not a smarter judge — the Sonnet resolver stays
 * structurally forbidden from ruling on the warning (CP-1). `ocr-retry.ts`'s
 * `shouldRetryOcr` decides whether the first attempt counts as that kind
 * of failure: a thrown/timed-out `null` (TRO-519's shared shape), or a
 * confidence below `OCR_CONFIDENCE_FLOOR` — the SAME constant
 * `reconcile.ts` already uses for "would force single-channel
 * degradation." The retry fires ONLY on that failure path, at most once,
 * against the SAME crop (no second region detection, no re-crop).
 *
 * **The retry-phase deadline (local CodeRabbit review round 1, TRO-583).**
 * An earlier draft bounded only the retry's OWN `deps.ocr` call (via that
 * call's existing per-call `OCR_TIMEOUT_MS`, TRO-519) and left
 * `deps.buildRetryVariant` itself unbounded between the two OCR calls —
 * the same gap this comment already names for `deps.detectRegion`/
 * `deps.crop`, but the ticket's own instruction ("never an unbounded
 * hang") does not accept that gap here. `runRetryPhaseWithDeadline`
 * (below) races `deps.buildRetryVariant` THEN `deps.ocr` together against
 * ONE `OCR_TIMEOUT_MS` timer — the SAME constant the first attempt
 * already trusts, reused rather than a new, independently-chosen number.
 * A timeout here abandons the retry and keeps the first attempt's own
 * result; it never invokes a THIRD attempt. This makes the channel's
 * analytic worst case exactly `2 * OCR_TIMEOUT_MS`, provably, not just in
 * the common case where `buildRetryVariant` happens to be fast (measured
 * distribution and this bound: this ticket's `CHANGES.md` entry).
 *
 * When the retry also fails, `retryOutcome ?? firstResult` falls back to
 * the FIRST attempt's own shape — `reconcile.ts`'s usability check treats
 * every combination of "unavailable" and "below floor" identically (both
 * are `ocrUsable = false`), so this is the exact single-channel outcome
 * the pre-TRO-583 code already produced, not a new one.
 *
 * A successful first attempt (`shouldRetryOcr` false) never calls
 * `deps.buildRetryVariant` or a second `deps.ocr` at all — the happy path
 * below this line is unchanged from the pre-TRO-583 code
 * (`index.test.ts`'s "does not call buildRetryVariant... — the happy path
 * is untouched by this ticket" test). */
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
   * display this value; nothing may fold it back into a verdict. */
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
