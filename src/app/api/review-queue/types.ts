/**
 * Shapes shared between the review-queue API routes (server) and the review
 * queue screens (`src/app/_components/`, client) — TRO-476, PRD §5, TH-R22.
 *
 * Pure types and pure constants only, the same discipline
 * `src/app/api/verify/types.ts` documents for its own shapes: no server-
 * only import (`pg`, `sharp`, `@anthropic-ai/sdk`) belongs in this file —
 * the client bundle imports it too.
 *
 * `Date` fields never cross this boundary as `Date` — `JSON.stringify`
 * would silently turn one into a string anyway, but a TYPE that still says
 * `Date` after that is a lie a client could trust right up until it calls a
 * `Date` method on a plain string. Every wire shape below spells
 * `createdAt`/`disposedAt` as `string` (ISO-8601) so the client's own
 * parsing (`new Date(value)`) is a visible, deliberate step, not an
 * accident that happens to work. This is specific to routes that cross a
 * real `fetch()`/JSON boundary — the review/detail PAGE
 * (`src/app/review-queue/[reviewQueueId]/page.tsx`) is a Server Component
 * that passes `src/server/review-queue`'s own `Date`-typed shapes straight
 * to a child component over React's own RSC serialization, which handles
 * `Date` natively, so it has no wire type here at all.
 */
import type { BeverageType, LabelVerdict, ReviewDisposition, ReviewReason } from "../../../lib/db/enums";
import type { ReviewQueueFieldDetail, ResolverSuggestedField } from "../../../server/review-queue";
// A VALUE import, so it comes from `../../../server/review-queue/types`
// directly rather than that package's barrel: the barrel also exports
// `list.ts`, which imports `pg`, and this module is bundled for the
// browser. The types module itself is pure by its own documented rule.
import { REVIEW_QUEUE_RESOLVER_STATUSES, type ReviewQueueResolverStatus } from "../../../server/review-queue/types";

export type { ReviewQueueFieldDetail, ResolverSuggestedField, ReviewQueueResolverStatus };
export { REVIEW_QUEUE_RESOLVER_STATUSES };

/** One row `GET /api/review-queue` returns — the wire twin of
 * `src/server/review-queue`'s `ReviewQueueListItem`, with `createdAt` as an
 * ISO-8601 string instead of a `Date`. */
export interface ReviewQueueListItemWire {
  id: number;
  verificationId: number;
  applicationId: number;
  reason: ReviewReason;
  reasonText: string;
  resolverStatus: ReviewQueueResolverStatus;
  brandName: string;
  classType: string;
  beverageType: BeverageType;
  labelVerdict: LabelVerdict;
  createdAt: string;
}

/** `GET /api/review-queue`'s success body — one page (TRO-507).
 * `nextCursor` carries the opaque position of the next page, or `null`
 * when this page ends the queue. A client that ignores it shows a
 * complete-looking list that is not one. */
export interface ReviewQueueListResponse {
  items: ReviewQueueListItemWire[];
  nextCursor: string | null;
}

/** `PATCH /api/review-queue/:id`'s request body. */
export interface RecordDispositionRequestBody {
  disposition: string;
}

/** `PATCH /api/review-queue/:id`'s success body. */
export interface RecordDispositionResponse {
  id: number;
  disposition: ReviewDisposition;
  disposedAt: string;
}

/** `PATCH /api/review-queue/:id`'s 409 body — the disposition that already
 * won, so the client can show it instead of a bare "conflict" message. */
export interface RecordDispositionConflictResponse {
  error: {
    kind: "CONFLICT";
    message: string;
  };
  disposition: ReviewDisposition;
  disposedAt: string;
}

/** Which designed error state (TH-R20) a review-queue route reports.
 * `NOT_FOUND` and `CONFLICT` are specific to the action endpoint — the list
 * endpoint only ever reports `SERVICE`. The array is the source of truth;
 * the type is derived from it, the same pattern
 * `src/app/api/verify/types.ts`'s `VERIFY_ERROR_KINDS` uses, so a client can
 * check a `kind` value from an HTTP response actually belongs to this set
 * before trusting it. */
export const REVIEW_QUEUE_ERROR_KINDS = ["VALIDATION", "NOT_FOUND", "CONFLICT", "SERVICE"] as const;
export type ReviewQueueErrorKind = (typeof REVIEW_QUEUE_ERROR_KINDS)[number];

export interface ReviewQueueErrorResponse {
  error: {
    kind: ReviewQueueErrorKind;
    message: string;
  };
}
