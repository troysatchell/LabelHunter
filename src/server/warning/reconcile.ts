/**
 * Dual/single-channel reconciliation (LH-020 / TRO-468, CP-2 §4.5, §6,
 * §7.1, TH-R9) — the function that turns two candidate readings (or one,
 * when OCR is unavailable) into the router's `WarningComparatorResult`.
 *
 * The decision tables this implements, quoted from CP-2:
 *
 * Dual-channel (§4.5):
 *   agree,    both equal canonical   -> PASS
 *   agree,    both differ            -> FAIL
 *   disagree, exactly one equals     -> REVIEW WARNING_MISMATCH
 *   disagree, neither equals         -> REVIEW WARNING_MISMATCH
 *
 * Single-channel (§4.5, OCR unavailable or below the confidence floor):
 *   equals canonical, VLM conf >= 0.90 -> PASS
 *   equals canonical, VLM conf <  0.90 -> REVIEW LOW_IMAGE_QUALITY
 *   differs from canonical             -> REVIEW WARNING_MISMATCH (NEVER FAIL)
 *
 * "Agree" (§4.5) means BOTH the folded words AND the caps-check result
 * match between channels — not just the words (`capsResultsEqual`, not a
 * bare string equality).
 *
 * The near-miss band (§5.5) and the caps hard-fail rule interact inside
 * the "agree" branch: a shared near-miss (distance 1-2, caps OK) is
 * REVIEW, matching §6.1's own unconditional "near miss -> REVIEW" row and
 * §2.6's missing-comma finding; a shared caps failure is FAIL regardless
 * of distance (§5.5 guard 1); a shared distance->=3 mismatch is FAIL
 * (§4.5's "both differ" row, and its own stated reason: two independent
 * engines agreeing on the same deviation is not a coincidental slip).
 *
 * §7.1's model cross-check ("code derives the casing; it does not trust
 * the model's report... when the derived casing and the model's
 * prefix_casing disagree, the result is REVIEW") is applied last, and can
 * only downgrade a PASS or FAIL to REVIEW — never the reverse.
 */
import { capsResultsEqual, hasAnyCapsFailure, isPrefixAllCaps } from "./caps";
import { evaluateCandidate, isExactMatch, type CandidateEvaluation } from "./wording-compare";
import type { WarningPrefixCasing } from "../extractor/types";
import type { WarningComparatorResult } from "../router/types";

/** The VLM channel's reading. `transcription` is non-null: the router
 * (`../router/field-resolution.ts`'s `resolveGovernmentWarningField`)
 * already resolves an absent or override-rejected warning to
 * `MISSING_REQUIRED_FIELD`/`CONFLICTING_EXTRACTION` before this comparator
 * is ever consulted (CP-2 §6.1's last row) — this module starts from "a
 * warning is present," not "is there one at all." */
export interface VlmWarningCandidate {
  transcription: string;
  /** The extractor's own self-report on the prefix's casing — a
   * cross-check, not the source of truth (CP-2 §7.1). */
  prefixCasing: WarningPrefixCasing;
  /** 0.00-1.00, the extractor's own confidence estimate. */
  confidence: number;
}

/** The OCR channel's reading, or its absence. `confidence` is Tesseract's
 * `MeanTextConf()`, 0-100 (CP-2 §4.3) — a different scale from the VLM's
 * 0.00-1.00, deliberately not normalized to match, since the two numbers
 * are never compared to each other, only each against its own threshold. */
export type OcrChannelInput = { available: true; text: string; confidence: number } | { available: false };

/** CP-2 §4.5, "proposed": an OCR candidate below this Tesseract confidence
 * is discarded — the dual-channel path falls back to single-channel rules
 * as though OCR had not run at all. Open question 7: kept as the starting
 * value; LH-030's golden-set sweep is what would replace it with a
 * measured one. */
export const OCR_CONFIDENCE_FLOOR = 60;

/** CP-1 §4.2's warning-transcription trusted threshold, reused here as
 * CP-2 §4.5's single-channel PASS floor — the same "confident enough to
 * act on" question, not a second, independently-chosen number. */
export const SINGLE_CHANNEL_PASS_CONFIDENCE = 0.9;

const NOTE = {
  match: "Government Warning matches the required text.",
  wordingMismatch: "Government Warning wording differs from the required text.",
  prefixCapsMismatch: "Government Warning must print in capital letters.",
  surgeonGeneralCapsMismatch: "Surgeon General must print with capital letters.",
  nearMiss: "Government Warning differs by a single character. A reviewer must confirm the exact wording.",
  channelsInconsistent: "Government Warning could not be read consistently.",
  lowImageQuality: "Government Warning is not clear enough in this image.",
  // CP-2 §6.1 does not draft a string for "single channel, not an exact
  // match, but not a clean near-miss either" — its table's rows are all
  // either dual-channel or the exact-match/low-confidence single-channel
  // rows. This is this ticket's own extension of §6.3's style for the
  // one uncovered case: one reading exists, it is not a clean match, and
  // §4.5 forbids calling it a FAIL on one channel alone.
  unconfirmedSingleChannel: "Government Warning could not be confirmed from this image alone.",
} as const;

/** Picks the §6.1 caps-failure UI reason. The prefix (27 CFR
 * 16.22(a)(2)) is checked first when both kinds of failure somehow
 * co-occur — an uncommon case CP-2 does not itself order, but the prefix
 * rule is the one with direct statutory text, so it takes precedence. */
function capsFailureNote(caps: CandidateEvaluation["caps"]): string {
  if (caps.government === "WRONG_CASE" || caps.warning === "WRONG_CASE") return NOTE.prefixCapsMismatch;
  return NOTE.surgeonGeneralCapsMismatch;
}

function matchResult(): WarningComparatorResult {
  return { verdict: "MATCH", note: NOTE.match };
}

function reviewResult(
  reviewReason: "WARNING_MISMATCH" | "LOW_IMAGE_QUALITY",
  note: string,
): WarningComparatorResult {
  return { verdict: "NEEDS_REVIEW", reviewReason, note };
}

function mismatchResult(note: string): WarningComparatorResult {
  return { verdict: "MISMATCH", note };
}

/** CP-2 §4.5's single-channel table. Never returns MISMATCH — "a
 * single-channel FAIL is never allowed, only REVIEW" (this ticket's own
 * load-bearing decision, matching §4.5: "we never accuse on one channel"). */
function reconcileSingleChannel(vlmEval: CandidateEvaluation, vlmConfidence: number): WarningComparatorResult {
  if (isExactMatch(vlmEval)) {
    return vlmConfidence >= SINGLE_CHANNEL_PASS_CONFIDENCE
      ? matchResult()
      : reviewResult("LOW_IMAGE_QUALITY", NOTE.lowImageQuality);
  }
  // A near miss keeps its precise, distance-based note (CP-2 §5.5) even on
  // one channel — it describes what was found, not how many readers found
  // it. Anything else (a caps failure or a real mismatch) gets the generic
  // single-channel note: one reading is never enough to accuse (§4.5).
  const note = vlmEval.wording === "NEAR_MISS" ? NOTE.nearMiss : NOTE.unconfirmedSingleChannel;
  return reviewResult("WARNING_MISMATCH", note);
}

/** CP-2 §4.5's dual-channel table, with the near-miss/caps interaction
 * resolved per this file's header comment. */
function reconcileDualChannel(vlmEval: CandidateEvaluation, ocrEval: CandidateEvaluation): WarningComparatorResult {
  const agree = vlmEval.folded === ocrEval.folded && capsResultsEqual(vlmEval.caps, ocrEval.caps);
  if (!agree) {
    return reviewResult("WARNING_MISMATCH", NOTE.channelsInconsistent);
  }

  // Agreement makes the two candidates interchangeable for classification
  // purposes — use the VLM's own evaluation as the shared reading.
  if (isExactMatch(vlmEval)) return matchResult();
  if (hasAnyCapsFailure(vlmEval.caps)) return mismatchResult(capsFailureNote(vlmEval.caps));
  if (vlmEval.wording === "NEAR_MISS") return reviewResult("WARNING_MISMATCH", NOTE.nearMiss);
  return mismatchResult(NOTE.wordingMismatch); // wording === "MISMATCH", caps OK
}

/**
 * CP-2 §7.1: the extractor's self-reported `prefix_casing` is a
 * consistency cross-check on the VLM channel's OWN derived caps result,
 * not a second vote — code remains the source of truth for the verdict.
 * A disagreement can only downgrade an already-decided PASS or FAIL to
 * REVIEW; a result that is already REVIEW is left alone.
 *
 * `NOT_VISIBLE` is not a claim, so it cannot disagree with one — it means
 * the model could not judge the prefix's casing at all, not that it
 * judged the prefix non-all-caps. Treating it as an active "not ALL_CAPS"
 * vote would flag a correct, confident derived read as inconsistent
 * whenever the model merely abstained. `OTHER` and `TITLE_CASE` are real,
 * competing claims (the model asserts a specific casing that is not
 * ALL_CAPS) and still participate in the check normally.
 */
function applyPrefixCasingCrossCheck(
  result: WarningComparatorResult,
  vlmCaps: CandidateEvaluation["caps"],
  prefixCasing: WarningPrefixCasing,
): WarningComparatorResult {
  if (prefixCasing === "NOT_VISIBLE") return result;

  const derivedAllCaps = isPrefixAllCaps(vlmCaps);
  const modelSaysAllCaps = prefixCasing === "ALL_CAPS";
  if (derivedAllCaps === modelSaysAllCaps) return result;
  if (result.verdict === "NEEDS_REVIEW") return result;
  return reviewResult("WARNING_MISMATCH", NOTE.channelsInconsistent);
}

/**
 * The whole reconciliation: evaluates both channels against the canonical
 * text, applies CP-2 §4.5's dual- or single-channel table, then CP-2
 * §7.1's prefix_casing cross-check. Pure and synchronous — this ticket's
 * comparator calls no model itself; it consumes the VLM transcription the
 * extractor already produced and (when available) an OCR reading.
 */
export function reconcileWarningChannels(vlm: VlmWarningCandidate, ocr: OcrChannelInput): WarningComparatorResult {
  const vlmEval = evaluateCandidate(vlm.transcription);
  const ocrUsable = ocr.available && ocr.confidence >= OCR_CONFIDENCE_FLOOR;

  const tentative = ocrUsable && ocr.available // `ocr.available` narrows the union for TS a second time after `ocrUsable`
    ? reconcileDualChannel(vlmEval, evaluateCandidate(ocr.text))
    : reconcileSingleChannel(vlmEval, vlm.confidence);

  return applyPrefixCasingCrossCheck(tentative, vlmEval.caps, vlm.prefixCasing);
}
