/**
 * The real brand_name / class_type comparator (LH-013 / TRO-463, CP-1 §5.3
 * `AMBIGUOUS_BRAND`, TH-R8). "You need judgment" (Dave Morrison) — a
 * normalized-equivalence check with a fuzzy fallback, never a hard string
 * match, and never a silent FAIL.
 *
 * CP-1 §5.3's table, implemented exactly:
 *
 *   normalized similarity >= 0.95  -> MATCH (note when the raw strings differ)
 *   normalized similarity <  0.95  -> NEEDS_REVIEW (AMBIGUOUS_BRAND)
 *
 * "The same rule applies to class_type, with the same threshold" — so one
 * function serves both fields; `field-resolution.ts` already gives each its
 * own `ReviewReason` from a single `AMBIGUOUS_BRAND` source (CP-1 §5.3).
 */
import type { ExtractedField } from "../extractor/types";
import type { ComparatorContext, ComparatorResult } from "../router/types";
import { normalizeForFuzzyMatch } from "./normalize";
import { similarity } from "./similarity";

/** CP-1 §5.3's own number — proposed, not yet measured (§4.5: the golden-set
 * threshold sweep, LH-030, replaces every "proposed" number in this design). */
export const BRAND_CLASS_MATCH_THRESHOLD = 0.95;

export function compareBrandOrClass(
  extracted: ExtractedField,
  applicationValue: string | number,
  _context: ComparatorContext,
): ComparatorResult {
  if (extracted.value === null) {
    return { verdict: "NEEDS_REVIEW", note: "No label value to compare." };
  }

  const labelText = extracted.value;
  const applicationText = String(applicationValue);
  const score = similarity(normalizeForFuzzyMatch(labelText), normalizeForFuzzyMatch(applicationText));

  if (score >= BRAND_CLASS_MATCH_THRESHOLD) {
    if (labelText === applicationText) {
      return { verdict: "MATCH" };
    }
    return { verdict: "MATCH", note: `Matches once formatting is normalized: "${labelText}" = "${applicationText}".` };
  }

  // PRD §3.3 / CP-1 §5.3: distance beyond the threshold goes to REVIEW,
  // never a silent FAIL — even a wholly different brand. A resolver call
  // costs money; a wrong verdict costs the agency's trust.
  return {
    verdict: "NEEDS_REVIEW",
    note: "The label and application text differ enough that a person should confirm this is the same value.",
  };
}
