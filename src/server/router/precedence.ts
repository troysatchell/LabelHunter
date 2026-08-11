/**
 * `ReviewReason` precedence (CP-1 §5.2). More than one reason can fire on
 * one label. The router keeps every reason that fired — a field's own row
 * carries its own reason, and the label-level blockers are tracked
 * separately — and this file picks the single highest-ranked one as the
 * label's headline, the one the UI shows first.
 */
import type { ReviewReason } from "./types";

/** Rank order, highest first, exactly as CP-1 §5.2 gives it. */
export const REVIEW_REASON_PRECEDENCE: readonly ReviewReason[] = [
  "LOW_IMAGE_QUALITY",
  "CONFLICTING_EXTRACTION",
  "MISSING_REQUIRED_FIELD",
  "WARNING_MISMATCH",
  "AMBIGUOUS_ABV",
  "AMBIGUOUS_NET_CONTENTS",
  "AMBIGUOUS_BRAND",
  "LOW_MODEL_CONFIDENCE",
];

/** Picks the single highest-ranked reason present in `reasons`, or `null`
 * when the set is empty (a clean PASS). */
export function pickHeadlineReason(reasons: ReadonlySet<ReviewReason>): ReviewReason | null {
  for (const reason of REVIEW_REASON_PRECEDENCE) {
    if (reasons.has(reason)) return reason;
  }
  return null;
}
