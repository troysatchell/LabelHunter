/**
 * Dual/single-channel reconciliation (CP-2 §4.5, §6, §7.1, TH-R9). It
 * turns two candidate readings — or one, when OCR is unavailable — into
 * the router's `WarningComparatorResult`.
 *
 * The decision tables it implements, quoted from CP-2:
 *
 * Dual-channel (§4.5):
 *   agree,    both equal canonical   -> PASS
 *   agree,    both differ            -> FAIL
 *   disagree, exactly one equals     -> REVIEW WARNING_MISMATCH
 *   disagree, neither equals         -> REVIEW WARNING_MISMATCH
 *
 * Single-channel (§4.5 as amended 2026-08-13 — Troy's ruling, recorded in
 * cp2-warning-subsystem.md; OCR unavailable or below the confidence
 * floor):
 *   equals canonical,  VLM conf >= 0.90 -> PASS
 *   equals canonical,  VLM conf <  0.90 -> REVIEW LOW_IMAGE_QUALITY
 *   caps failure,      VLM conf >= 0.90 -> FAIL (caps reason)
 *   near miss,         any confidence   -> REVIEW WARNING_MISMATCH
 *   wording mismatch,  VLM conf >= 0.90 -> FAIL (wording reason)
 *   any non-match,     VLM conf <  0.90 -> REVIEW WARNING_MISMATCH
 *
 * "Agree" means both the folded words AND the caps result match between
 * channels, not the words alone.
 *
 * Inside the agree branch: a shared near miss (distance 1–2, caps OK) is
 * REVIEW; a shared caps failure is FAIL at any distance; a shared distance
 * of 3 or more is FAIL, because two independent engines landing on the
 * same deviation is not a coincidental slip.
 *
 * §7.1's cross-check runs last. Code derives the casing and never trusts
 * the model's own report of it. A disagreement can only downgrade PASS or
 * FAIL to REVIEW, never the reverse.
 */
import { capsResultsEqual, hasAnyCapsFailure, isPrefixAllCaps } from "./caps";
import { evaluateCandidate, isExactMatch, type CandidateEvaluation } from "./wording-compare";
import type { WarningPrefixCasing } from "../extractor/types";
import type { WarningComparatorChannel, WarningComparatorResult } from "../router/types";

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

/**
 * An OCR candidate below this Tesseract confidence is discarded, and the
 * dual-channel path falls back to single-channel rules (CP-2 §4.5).
 *
 * MEASURED 2026-08-12 by `scripts/eval/ocr-floor-sweep.ts`, replaying the
 * OCR channel against all 32 golden-set cases. Confidence fell into two
 * clusters with an empty gap between them:
 *
 *   - {56, 58} — case-24 and case-23, tiny warning print. Badly degraded
 *     but real: 42 and 47 edits from canonical.
 *   - {91, 95, 96} — every other warning-bearing case, including a glare
 *     reading (case-18) that stayed confident on garbage. Tesseract's
 *     confidence is not a read-quality oracle, which is why the
 *     dual-channel agreement check is the real safety net.
 *
 * The old floor of 60 sat inside that gap, above both tiny-print readings.
 * It discarded their evidence and let one confident vision channel PASS a
 * label whose only other reader produced 40-plus edits of garbage. Any
 * floor in the 59–90 gap repeats that bug.
 *
 * 50 is the midpoint of the 0–100 scale, 6–8 points under both tiny-print
 * readings — not the minimum that flips them (56 would). The corpus holds
 * nothing between blank-crop noise at 0 and 56, so this does not prove 50
 * over 40 or 45. That is a named limit, not a hidden one. See
 * `docs/checkpoints/cp2-warning-subsystem.md`'s amendment after §4.5 for
 * the full sweep table.
 */
export const OCR_CONFIDENCE_FLOOR = 50;

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
  // Since the 2026-08-13 CP-2 amendment this note covers only the
  // LOW-CONFIDENCE single-channel non-match: one reading exists, it is
  // not a clean match, and its confidence sits below the threshold the
  // pass rule trusts — so there is no certainty to act on either way.
  // A confident, self-consistent non-match now fails outright instead.
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

function matchResult(channel: WarningComparatorChannel): WarningComparatorResult {
  return { verdict: "MATCH", channel, note: NOTE.match };
}

function reviewResult(
  reviewReason: "WARNING_MISMATCH" | "LOW_IMAGE_QUALITY",
  note: string,
  channel: WarningComparatorChannel,
): WarningComparatorResult {
  return { verdict: "NEEDS_REVIEW", channel, reviewReason, note };
}

function mismatchResult(note: string, channel: WarningComparatorChannel): WarningComparatorResult {
  return { verdict: "MISMATCH", channel, note };
}

/** CP-2 §4.5's single-channel table, as amended 2026-08-13 (Troy's
 * ruling, recorded in `docs/checkpoints/cp2-warning-subsystem.md`): "it
 * should fail outright if it's that deterministic." One channel at the
 * SAME threshold the pass rule already trusts renders EITHER verdict when
 * the reading is structurally clean — the original "never accuse on one
 * channel" rule survives only for the genuinely uncertain reads. The
 * precedence below (caps, then near-miss, then wording) mirrors
 * `reconcileDualChannel` exactly, so the two tables classify one reading
 * the same way; only the confidence gate differs.
 *
 * §7.1's prefix-casing cross-check still runs AFTER this table and
 * downgrades a MISMATCH the model's own casing report contradicts — a
 * self-inconsistent reading is not "absolute certainty" and escalates. */
function reconcileSingleChannel(vlmEval: CandidateEvaluation, vlmConfidence: number): WarningComparatorResult {
  if (isExactMatch(vlmEval)) {
    return vlmConfidence >= SINGLE_CHANNEL_PASS_CONFIDENCE
      ? matchResult("single")
      : reviewResult("LOW_IMAGE_QUALITY", NOTE.lowImageQuality, "single");
  }
  if (vlmConfidence >= SINGLE_CHANNEL_PASS_CONFIDENCE) {
    if (hasAnyCapsFailure(vlmEval.caps)) return mismatchResult(capsFailureNote(vlmEval.caps), "single");
    // A near miss stays REVIEW at any confidence: a single-character
    // difference is within transcription noise, not a deviation the
    // amendment's "absolute certainty" covers. Its note stays precise and
    // distance-based (CP-2 §5.5) — it describes what was found.
    if (vlmEval.wording === "NEAR_MISS") return reviewResult("WARNING_MISMATCH", NOTE.nearMiss, "single");
    return mismatchResult(NOTE.wordingMismatch, "single");
  }
  const note = vlmEval.wording === "NEAR_MISS" ? NOTE.nearMiss : NOTE.unconfirmedSingleChannel;
  return reviewResult("WARNING_MISMATCH", note, "single");
}

/** CP-2 §4.5's dual-channel table, with the near-miss/caps interaction
 * resolved per this file's header comment. */
function reconcileDualChannel(vlmEval: CandidateEvaluation, ocrEval: CandidateEvaluation): WarningComparatorResult {
  const agree = vlmEval.folded === ocrEval.folded && capsResultsEqual(vlmEval.caps, ocrEval.caps);
  if (!agree) {
    return reviewResult("WARNING_MISMATCH", NOTE.channelsInconsistent, "dual");
  }

  // Agreement makes the two candidates interchangeable for classification
  // purposes — use the VLM's own evaluation as the shared reading.
  if (isExactMatch(vlmEval)) return matchResult("dual");
  if (hasAnyCapsFailure(vlmEval.caps)) return mismatchResult(capsFailureNote(vlmEval.caps), "dual");
  if (vlmEval.wording === "NEAR_MISS") return reviewResult("WARNING_MISMATCH", NOTE.nearMiss, "dual");
  return mismatchResult(NOTE.wordingMismatch, "dual"); // wording === "MISMATCH", caps OK
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
 *
 * `channel` is passed in, not read back off `result` — this function
 * refines whichever table already decided `result` (TRO-535 / LH-030b); it
 * runs no comparison of its own, so it reports the channel that actually
 * produced the evidence rather than guessing from an optional field.
 */
function applyPrefixCasingCrossCheck(
  result: WarningComparatorResult,
  vlmCaps: CandidateEvaluation["caps"],
  prefixCasing: WarningPrefixCasing,
  channel: WarningComparatorChannel,
): WarningComparatorResult {
  if (prefixCasing === "NOT_VISIBLE") return result;

  const derivedAllCaps = isPrefixAllCaps(vlmCaps);
  const modelSaysAllCaps = prefixCasing === "ALL_CAPS";
  if (derivedAllCaps === modelSaysAllCaps) return result;
  if (result.verdict === "NEEDS_REVIEW") return result;
  return reviewResult("WARNING_MISMATCH", NOTE.channelsInconsistent, channel);
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
  const channel: WarningComparatorChannel = ocrUsable ? "dual" : "single";

  const tentative = ocrUsable && ocr.available // `ocr.available` narrows the union for TS a second time after `ocrUsable`
    ? reconcileDualChannel(vlmEval, evaluateCandidate(ocr.text))
    : reconcileSingleChannel(vlmEval, vlm.confidence);

  return applyPrefixCasingCrossCheck(tentative, vlmEval.caps, vlm.prefixCasing, channel);
}
