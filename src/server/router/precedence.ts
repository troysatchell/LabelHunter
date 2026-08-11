/**
 * `ReviewReason` precedence (CP-1 §5.2). More than one reason can fire on
 * one label. The router keeps every reason that fired — a field's own row
 * carries its own reason, and the label-level blockers are tracked
 * separately — and this file picks the single highest-ranked one as the
 * label's headline, the one the UI shows first.
 */
import type { ReviewReason } from "./types";

/**
 * Rank order, exactly as CP-1 §5.2 gives it, expressed as a
 * `Record<ReviewReason, number>` rather than a plain ordered array.
 * TypeScript requires every member of the `ReviewReason` union to have an
 * entry here — a ninth reason added to the union without a rank is a
 * compile error in this file, not a silent gap `pickHeadlineReason` would
 * only reveal at runtime, or never reveal at all.
 */
const REVIEW_REASON_RANK: Record<ReviewReason, number> = {
  LOW_IMAGE_QUALITY: 0,
  CONFLICTING_EXTRACTION: 1,
  MISSING_REQUIRED_FIELD: 2,
  WARNING_MISMATCH: 3,
  AMBIGUOUS_ABV: 4,
  AMBIGUOUS_NET_CONTENTS: 5,
  AMBIGUOUS_BRAND: 6,
  LOW_MODEL_CONFIDENCE: 7,
};

/** Rank order, highest first, derived from `REVIEW_REASON_RANK` above. */
export const REVIEW_REASON_PRECEDENCE: readonly ReviewReason[] = (Object.keys(REVIEW_REASON_RANK) as ReviewReason[])
  .slice()
  .sort((a, b) => REVIEW_REASON_RANK[a] - REVIEW_REASON_RANK[b]);

/** Picks the single highest-ranked reason present in `reasons`, or `null`
 * when the set is empty (a clean PASS). */
export function pickHeadlineReason(reasons: ReadonlySet<ReviewReason>): ReviewReason | null {
  for (const reason of REVIEW_REASON_PRECEDENCE) {
    if (reasons.has(reason)) return reason;
  }
  return null;
}
