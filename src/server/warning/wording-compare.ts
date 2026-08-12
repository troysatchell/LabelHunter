/**
 * The per-candidate wording-compare primitive (LH-020 / TRO-468, CP-2
 * §3.3, §5.5, TH-R9). Implements the algorithm CP-2 §3.3 states precisely
 * for ONE candidate transcription:
 *
 *   1. raw        = candidate, exactly as the reader returned it
 *   2. normalized = normalizeTransport(raw)           # case-preserving
 *   3. capsOK     = checkCapitalPositions(normalized) # BEFORE folding
 *   4. compared   = foldCase(normalized)
 *   5. canonical  = foldCase(normalizeTransport(CANONICAL_WARNING_TEXT))
 *   6. distance   = 0 if compared === canonical else levenshtein(...)
 *
 * `reconcile.ts` combines two of these (VLM + OCR) into the dual/single-
 * channel `WarningComparatorResult` CP-2 §4.5 and §6 specify. This module
 * does not decide PASS/FAIL/REVIEW — it only classifies one candidate
 * against the canonical text.
 */
import { capsCheckPasses, checkCapitalPositions, type CapsCheckResult } from "./caps";
import { CANONICAL_WARNING_TEXT } from "./canonical";
import { levenshteinDistance } from "./distance";
import { foldCase, normalizeTransport } from "./normalize";

/**
 * CP-2 §5.5's proposed near-miss band, adopted per open question 2's
 * recommendation: an edit distance of 1 or 2 after normalization is a
 * REVIEW-band near miss, not an outright mismatch. The nearest genuine
 * deviation measured in the golden set (case-11 shape) is distance 24 —
 * twelve times this band (CP-2 §5.4).
 */
export const NEAR_MISS_MAX_DISTANCE = 2;

/** One candidate's classification against the canonical wording, by edit
 * distance alone — independent of the caps check (CP-2 §5.5 guard 1: "the
 * band never applies to capitalization"). */
export type WordingClassification = "EXACT_MATCH" | "NEAR_MISS" | "MISMATCH";

export interface CandidateEvaluation {
  /** The transcription exactly as the reader returned it. */
  raw: string;
  /** Transport-normalized, case-preserving — what the caps check ran on. */
  normalized: string;
  /** Case-folded, for the distance comparison. */
  folded: string;
  /** CP-2 §7.1: the four checked positions, from the case-preserving form. */
  caps: CapsCheckResult;
  /** Levenshtein distance between `folded` and the folded canonical text. */
  distance: number;
  /** `distance`'s classification under CP-2 §5.5's band. */
  wording: WordingClassification;
}

const FOLDED_CANONICAL = foldCase(normalizeTransport(CANONICAL_WARNING_TEXT));

function classifyDistance(distance: number): WordingClassification {
  if (distance === 0) return "EXACT_MATCH";
  if (distance <= NEAR_MISS_MAX_DISTANCE) return "NEAR_MISS";
  return "MISMATCH";
}

/** Runs CP-2 §3.3's six-step algorithm on one raw candidate transcription. */
export function evaluateCandidate(raw: string): CandidateEvaluation {
  const normalized = normalizeTransport(raw);
  const caps = checkCapitalPositions(normalized);
  const folded = foldCase(normalized);
  const distance = folded === FOLDED_CANONICAL ? 0 : levenshteinDistance(folded, FOLDED_CANONICAL);
  return { raw, normalized, folded, caps, distance, wording: classifyDistance(distance) };
}

/**
 * A candidate is a true exact match only when BOTH the wording is exactly
 * canonical (distance 0) AND all four caps positions conform. CP-2 §5.5
 * guard 2: the near-miss band never turns a would-be FAIL into a PASS, and
 * a caps failure is never forgiven by a small distance — this function is
 * the single place that combines both conditions, so no caller can check
 * one and forget the other.
 */
export function isExactMatch(evaluation: CandidateEvaluation): boolean {
  return evaluation.wording === "EXACT_MATCH" && capsCheckPasses(evaluation.caps);
}
