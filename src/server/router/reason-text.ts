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
  AMBIGUOUS_ABV: "The alcohol content needs a closer look.",
  AMBIGUOUS_NET_CONTENTS: "The net contents need a closer look.",
  AMBIGUOUS_BRAND: "This field needs a closer look.",
  LOW_MODEL_CONFIDENCE: "The extractor was not sure it read this field correctly.",
};

export function buildFieldReasonText(
  verdict: FieldVerdict,
  reviewReason: ReviewReason | null,
  comparatorNote: string | undefined,
): string {
  if (comparatorNote) return comparatorNote;
  if (reviewReason) return REASON_TEXT_BY_REVIEW_REASON[reviewReason];
  return verdict === "MISMATCH" ? "Does not match the application." : "Matches the application.";
}
