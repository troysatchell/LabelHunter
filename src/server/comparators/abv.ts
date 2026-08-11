/**
 * The real ABV grammar and comparator (LH-013 / TRO-463, CP-1 §3.2's worked
 * example, §5.3 `AMBIGUOUS_ABV`, TH-R11).
 *
 * Replaces `../router/provisional-numeric.ts`'s `provisionalParseAbv` as
 * this system's ABV parser — that file's own docstring names this ticket as
 * its replacement's owner. `../router/field-resolution.ts` and
 * `../router/overrides.ts` import from here now, not from the stand-in.
 */
import type { ExtractedField } from "../extractor/types";
import type { ComparatorContext, ComparatorResult } from "../router/types";

export interface ParsedAbv {
  percent: number | null;
  proof: number | null;
}

/** A percent statement: a number followed by `%` or the word "percent".
 * `\b` sits only after the word form — a `%` symbol is not a word
 * character, so a `\b` placed right after it would require a word
 * character on the OTHER side to count as a boundary, which fails on the
 * ordinary case of a space following the `%` (e.g. `"45% Alc./Vol."`). */
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:%|percent\b)/i;

/** A proof statement: a number, an optional `°` or "degree(s)", then the
 * word "proof". Covers CP-1's own example ("90 Proof") and the "90 degrees
 * proof" / "90° proof" phrasing seen on some spirits labels. */
const PROOF_PATTERN = /(\d+(?:\.\d+)?)\s*(?:°\s*)?(?:degrees?\s+)?proof\b/i;

/**
 * Reads a percent and/or a proof number out of free text, e.g.
 * `"45% Alc./Vol. (90 Proof)"` -> `{ percent: 45, proof: 90 }`. Order in the
 * source text does not matter — both patterns scan the whole string
 * independently, so `"90 Proof (45% Alc./Vol.)"` parses the same way
 * (golden-set case-04's own point: field-order robustness, not just
 * parsing). Either or both may be `null` when that pattern is absent —
 * an ABV-optional beverage (e.g. beer, CP-1 §5.3's beer/wine VERIFY cells)
 * legitimately has neither.
 */
export function parseAbv(text: string): ParsedAbv {
  const percentMatch = text.match(PERCENT_PATTERN);
  const proofMatch = text.match(PROOF_PATTERN);
  return {
    percent: percentMatch ? Number(percentMatch[1]) : null,
    proof: proofMatch ? Number(proofMatch[1]) : null,
  };
}

/**
 * Converts a parsed reading to a single canonical percent, preferring the
 * stated percent and falling back to proof/2 when only proof is stated —
 * 27 CFR 5.1 defines proof as "the ethyl alcohol content of a liquid ...
 * stated as twice the percentage of ethyl alcohol by volume". `null` when
 * neither number is present.
 */
export function abvAsPercent(parsed: ParsedAbv): number | null {
  if (parsed.percent !== null) return parsed.percent;
  if (parsed.proof !== null) return parsed.proof / 2;
  return null;
}

/** A tiny float-rounding allowance, not a labeling tolerance — "45%" and a
 * proof reading that converts to 45.0000...4% (parser float slop) are the
 * same statement restated, not a real disagreement. */
const PROOF_ARITHMETIC_EPSILON = 0.1;

/**
 * CP-1 §5.3's self-contradiction check, 27 CFR 5.1's own arithmetic: proof
 * must equal twice the percent. `"45% Alc./Vol. (100 Proof)"` is CP-1's own
 * named example of a label that fails this — 100 is not 2 * 45.
 */
export function proofMatchesPercent(percent: number, proof: number): boolean {
  return Math.abs(proof - 2 * percent) <= PROOF_ARITHMETIC_EPSILON;
}

/**
 * A float-rounding allowance ONLY — not a TTB labeling tolerance. Verified
 * against eCFR: 27 CFR 5.65(b) (spirits, +/-0.3 percentage points) and
 * 27 CFR 4.36(b) (wine, +/-1 to 3 percentage points depending on range)
 * both govern how far the ACTUAL bottled product may deviate from its OWN
 * label's printed statement — a product-QC tolerance. That is a different
 * question from this comparator's: does the label's PRINTED number match
 * what the APPLICANT TYPED on the application form. A careful applicant's
 * form and their own label should state the identical number; zero
 * tolerance here is not "strictest interpretation kept pending
 * verification" (CP-1 §5.3's original VERIFY framing) — it is the verified,
 * correct answer, because the regulatory tolerance does not apply to this
 * comparison at all.
 */
const ABV_COMPARE_EPSILON = 0.005;

/**
 * MATCH when the label's canonical percent equals the application's
 * declared percent (within `ABV_COMPARE_EPSILON`'s float-rounding
 * allowance); MISMATCH when it does not (golden-set case-05/case-06).
 * NEEDS_REVIEW when either side cannot be read as a number — never a
 * fabricated MATCH or MISMATCH over a value this comparator cannot parse
 * (TH-R10).
 */
export function compareAbv(
  extracted: ExtractedField,
  applicationValue: string | number,
  _context: ComparatorContext,
): ComparatorResult {
  if (extracted.value === null) {
    return { verdict: "NEEDS_REVIEW", note: "No label value to compare." };
  }

  const parsed = parseAbv(extracted.value);
  const labelPercent = abvAsPercent(parsed);
  const applicationPercent = typeof applicationValue === "number" ? applicationValue : null;

  if (labelPercent === null || applicationPercent === null) {
    return { verdict: "NEEDS_REVIEW", note: "Could not read an alcohol percent to compare." };
  }

  // CP-1 §5.3's own named case: a label stating BOTH a percent and a proof
  // that disagree ("45% Alc./Vol. (100 Proof)") is self-contradictory on
  // its own terms, independent of what the application declares. Checking
  // this here — not only in the router's separate structural check
  // (field-resolution.ts's checkAbvStructural) — keeps this comparator
  // correct as a standalone pure function, not merely correct once wrapped
  // by the router's own redundant check.
  if (parsed.percent !== null && parsed.proof !== null && !proofMatchesPercent(parsed.percent, parsed.proof)) {
    return {
      verdict: "NEEDS_REVIEW",
      note: `Label states ${parsed.percent}% ABV and ${parsed.proof} proof, which do not agree — proof should be twice the percent.`,
    };
  }

  if (Math.abs(labelPercent - applicationPercent) <= ABV_COMPARE_EPSILON) {
    return { verdict: "MATCH" };
  }
  return {
    verdict: "MISMATCH",
    note: `Label states ${labelPercent}% ABV; application states ${applicationPercent}%.`,
  };
}
