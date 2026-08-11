/**
 * One line of UI English per field row (CP-1 §5.5, PRD §3.3, TH-R20): never
 * a bare confidence percentage. Prefers a comparator's own note; falls back
 * to a generic sentence keyed by the `ReviewReason`, then by the verdict.
 */
import type { FieldVerdict, ReviewReason } from "./types";

const REASON_TEXT_BY_REVIEW_REASON: Record<ReviewReason, string> = {
  LOW_IMAGE_QUALITY: "The image is not clear enough to read this field with confidence.",
  CONFLICTING_EXTRACTION: "The extracted evidence does not support this value. A human must check it.",
  MISSING_REQUIRED_FIELD: "This field is required. The label did not show it.",
  WARNING_MISMATCH: "The government warning needs a closer look.",
  AMBIGUOUS_ABV: "A reviewer must check the alcohol content against the label.",
  AMBIGUOUS_NET_CONTENTS: "A reviewer must check the net contents against the label.",
  AMBIGUOUS_BRAND: "A reviewer must check the brand name or class and type against the label.",
  LOW_MODEL_CONFIDENCE: "The extractor was not sure it read this field correctly.",
};

/**
 * The default text a row falls back to when there is no comparator note and
 * no `ReviewReason` — CP-1 §5.3's own carve-out (`MISSING_REQUIRED_FIELD`
 * does not fire under `LOW_IMAGE_QUALITY`) leaves a field at `NEEDS_REVIEW`
 * with `reviewReason: null`. A verdict-only fallback that only checks for
 * `"MISMATCH"` would print "Matches the application." for that field — a
 * needs-review row must not be worded like a clean match.
 */
export function buildFieldReasonText(
  verdict: FieldVerdict,
  reviewReason: ReviewReason | null,
  comparatorNote: string | undefined,
): string {
  if (comparatorNote) return comparatorNote;
  if (reviewReason) return REASON_TEXT_BY_REVIEW_REASON[reviewReason];
  if (verdict === "NEEDS_REVIEW") return "This field needs a closer look.";
  return verdict === "MISMATCH" ? "Does not match the application." : "Matches the application.";
}
