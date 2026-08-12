/**
 * Types for the review queue's read side and disposition action (TRO-476,
 * PRD §5, TH-R22). Pure types and one pure constant only — no `pg` or any
 * other server-only import belongs in this file, the same discipline
 * `src/app/api/verify/types.ts` documents for its own shapes.
 *
 * `FIELD_NAME_LABELS` below is a short, intentional duplicate of
 * `src/app/api/verify/types.ts`'s own `FIELD_LABELS`. No file under
 * `src/server/` imports from `src/app/` anywhere in this codebase — this
 * module keeps that one-directional layering rather than being the first
 * exception for five short strings. It is keyed by `FieldName` (the
 * Postgres enum `field_results.field_name` actually stores), not
 * `RouterFieldKey`, so this module never needs a conversion between the
 * two closed sets just to print a heading.
 */
import type {
  BeverageType,
  FieldName,
  FieldVerdict,
  LabelVerdict,
  ReviewDisposition,
  ReviewReason,
} from "../../lib/db/enums";

export const FIELD_NAME_LABELS: Record<FieldName, string> = {
  BRAND_NAME: "Brand name",
  CLASS_TYPE: "Class/type",
  ALCOHOL_CONTENT: "Alcohol content",
  NET_CONTENTS: "Net contents",
  GOVERNMENT_WARNING: "Government warning",
};

/**
 * One row the queue list shows (PRD §5: "needs-human items with reason").
 * Deliberately thin — just enough for a reviewer to judge which item to
 * open next, per the ticket's own UI bullet ("reason, brief context, link
 * to review"). The full field-by-field comparison lives in
 * `ReviewQueueItemDetail`, read only once a reviewer opens one item.
 */
export interface ReviewQueueListItem {
  /** `review_queue.id` — the row this list item and its detail/action both
   * key on. */
  id: number;
  verificationId: number;
  applicationId: number;
  reason: ReviewReason;
  /** One line of UI English (TH-R20) — never a bare confidence percentage.
   * Built from `reason` by `buildFieldReasonText`, the same function
   * `src/app/api/verify/route.ts` uses for the live "needs review" flag, so
   * this never says the same fact a second, different way. */
  reasonText: string;
  brandName: string;
  classType: string;
  beverageType: BeverageType;
  labelVerdict: LabelVerdict;
  createdAt: Date;
}

/** One field's extracted-vs-application comparison, for the review/detail
 * view (PRD §5's "extracted vs application values per field"). Mirrors the
 * Detail view's own per-field shape in spirit — same underlying data,
 * `field_results` plus `applications` — but is this module's own,
 * independent read: `src/server/verification-detail` (LH-016/TRO-466) is
 * not merged as of this ticket (still PR #15, open), so nothing here
 * imports from it. See this ticket's report for the flagged duplication. */
export interface ReviewQueueFieldDetail {
  field: FieldName;
  fieldLabel: string;
  verdict: FieldVerdict;
  /** What the extractor read on the label, cleaned. `null` when absent. */
  labelValue: string | null;
  /** Verbatim label text supporting `labelValue`. Empty string when absent. */
  evidence: string;
  /** What the applicant filed, formatted for display. See
   * `get-item.ts`'s `applicationValueForField` for the government-warning
   * carve-out (no per-application value exists for that field). */
  applicationValue: string;
  /** One line of UI English, already persisted verbatim on `field_results.
   * reason` at verify time (`src/server/router/index.ts`'s own
   * `buildFieldReasonText` call) — read back, not recomputed. */
  reason: string;
}

/**
 * One field the Sonnet resolver looked at, shaped for display only.
 * Deliberately loose compared to `src/server/resolver/types.ts`'s own
 * `ResolvedFieldResult` (a strict discriminated union): this type exists to
 * show a reviewer what the model said, not to gate a business decision the
 * way `src/server/resolver/queue.ts`'s `isResolverResolution` does. A field
 * this repo's stricter reader would reject outright (e.g. a legacy fixture
 * shape) still has SOMETHING worth showing here, or is skipped — see
 * `get-item.ts`'s `summarizeResolverOutput`. `confidence` is intentionally
 * absent: standing rule 12 says a bare confidence number is never shown.
 */
/**
 * A discriminated union on `kind`, not independently-optional
 * `disposition`/`needsHuman` fields (CLAUDE.md standing rule 19 — CodeRabbit
 * local review round 1 flagged the earlier, flat shape: `disposition` was
 * only ever meaningful on a `"judged"` field and `needsHuman` only on a
 * `"correction"` field, exactly the shape that rule exists to catch).
 * Mirrors `resolver/types.ts`'s own `JudgedFieldResolution` /
 * `CorrectionFieldResolution` split (CP-1 §6.5) at the display layer.
 */
export type ResolverSuggestedField =
  | {
      field: string;
      kind: "judged";
      disposition: string;
      correctedValue: string | null;
      evidence: string;
      reason: string;
    }
  | {
      field: string;
      kind: "correction";
      needsHuman: boolean;
      correctedValue: string | null;
      evidence: string;
      reason: string;
    };

/** The full review/detail view for one queue item (PRD §5). */
export interface ReviewQueueItemDetail {
  id: number;
  verificationId: number;
  applicationId: number;
  reason: ReviewReason;
  reasonText: string;
  labelVerdict: LabelVerdict;
  brandName: string;
  classType: string;
  beverageType: BeverageType;
  createdAt: Date;
  /** `null` until a human approves or rejects this item. Every item the
   * list view returns is in this state, because `listUnresolvedReviewQueue`
   * filters on `disposition IS NULL`. */
  disposition: ReviewDisposition | null;
  disposedAt: Date | null;
  /** The resolver's free-text note, when `resolver_output` is an object
   * with a string `note` property — present even on a legacy fixture shape
   * that fails the stricter structural check below. `null` when absent or
   * when `resolver_output` itself is null. That is the normal, expected
   * state for every item reachable through this app's real request path
   * today: nothing yet calls `resolveEscalatedLabel` off a `review_queue`
   * row (see this ticket's report), so `resolver_output` is null on every
   * live row. */
  resolverNote: string | null;
  /** The resolver's structured, field-by-field suggestion, when
   * `resolver_output` matches the current resolver's shape closely enough
   * to show. `null` when `resolver_output` is null (the normal case today)
   * or does not look like this shape at all. */
  resolverFields: ResolverSuggestedField[] | null;
  fields: ReviewQueueFieldDetail[];
}

/** `getReviewQueueItem`'s result: a discriminated union, not a nullable
 * return, so a caller cannot read `.item` without first checking `found`. */
export type GetReviewQueueItemResult =
  | { found: true; item: ReviewQueueItemDetail }
  | { found: false };

/**
 * `recordDisposition`'s result: a discriminated union (CLAUDE.md standing
 * rule 19 — a field whose validity depends on another field needs a
 * discriminated union, not independently-optional fields). `disposition`
 * and `disposedAt` are only meaningful together, on the `"recorded"` and
 * `"already-disposed"` branches, never independently optional on one flat
 * shape.
 */
export type RecordDispositionOutcome =
  | { status: "recorded"; id: number; disposition: ReviewDisposition; disposedAt: Date }
  | { status: "not-found" }
  | { status: "already-disposed"; disposition: ReviewDisposition; disposedAt: Date };
