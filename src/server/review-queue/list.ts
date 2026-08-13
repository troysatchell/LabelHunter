/**
 * Reads unresolved review-queue items (TRO-476, PRD §5, TH-R22): "needs-
 * human items with reason." Read-only and DB-backed, same posture as
 * `src/server/verification-detail`'s own read module — it never calls a
 * model, it only shapes rows the live verify path
 * (`src/app/api/verify/route.ts`) already persisted. The cascade is the
 * architecture (TH-R19): a read path is not a place to add a second one.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { db as defaultDb } from "../../lib/db";
import { applications, reviewQueue, verifications } from "../../lib/db/schema";
import { buildFieldReasonText } from "../router/reason-text";
import { encodeReviewQueueCursor, type ReviewQueueCursor } from "./cursor";
import type { ReviewQueueListItem, ReviewQueueListPage, ReviewQueueResolverStatus } from "./types";

/**
 * `INNER JOIN`, not a defensive `LEFT JOIN` plus a null check: every FK from
 * `review_queue` to `verifications` to `applications` is `NOT NULL` with
 * `ON DELETE CASCADE` (`schema.ts`). Deleting an application deletes its
 * verification and its review-queue row in the same cascade — an orphaned
 * review-queue row pointing at a missing application cannot exist under
 * normal operation, so there is no anomaly here to defend against.
 *
 * The `WHERE` clause matches `review_queue_unresolved_idx` (`schema.ts`) —
 * a partial index on `createdAt` `WHERE disposition IS NULL` — by design,
 * not by accident. Observed via `EXPLAIN` against this worktree's database
 * (empty table, so a measurement of the filter path only, not a load test):
 * Postgres picks a `Bitmap Index Scan` on this index for the `disposition
 * IS NULL` filter, then a separate `Sort` node for `ORDER BY createdAt` —
 * a bitmap scan does not return rows in index order, so the sort step is
 * real at this table size. Whether a larger table's planner instead
 * chooses a plain ordered `Index Scan` that serves both the filter and the
 * order in one pass is not measured here — this module does not fabricate
 * that number. TRO-507's keyset predicate below keeps the same shape: it
 * compares the same `(createdAt, id)` pair the `ORDER BY` already uses, so
 * the leading column the index is built on still leads.
 *
 * `LIMIT` (CodeRabbit local review round 1): an unbounded read of every
 * unresolved item does not scale as the queue grows. A second `ORDER BY`
 * key (`reviewQueue.id`) makes the order deterministic even when two rows
 * share one `createdAt` — Postgres gives no ordering guarantee among rows
 * that tie on the only sort key it is given.
 */
const DEFAULT_LIST_LIMIT = 100;

/**
 * The largest page one request may ask for (TRO-507). The limit's ceiling
 * is unchanged from the value PR #16 chose — this ticket did not widen it,
 * it added a way to read PAST it. A queue deeper than one page is now
 * reachable through `nextCursor`, one page at a time, instead of being
 * silently cut off at 100 items with nothing on screen saying so.
 */
export const MAX_LIST_LIMIT = DEFAULT_LIST_LIMIT;

export interface ListUnresolvedReviewQueueOptions {
  /** Page size, 1 through `MAX_LIST_LIMIT`. Defaults to
   * `DEFAULT_LIST_LIMIT`. */
  limit?: number;
  /** Read the page that follows this position. Omit for the first page. */
  after?: ReviewQueueCursor;
}

/**
 * Derives what the resolver has done for one row (TRO-512, CP-3 §3.3).
 *
 * The reservation (TRO-506) creates a row before Sonnet answers, so
 * `resolverOutput IS NULL` no longer means one thing. CP-3 §3.3 names the
 * exact hazard: a reserved row and a deliberately skipped row would both
 * render as "no resolver suggestion yet", and a reviewer cannot tell "wait
 * a few seconds and refresh" apart from "nothing is coming." This function
 * separates the four real states so the UI can say which one it is.
 */
function deriveResolverStatus(row: {
  resolverOutput: unknown;
  resolverSkipReason: string | null;
  resolverReservedUntil: Date | null;
}): ReviewQueueResolverStatus {
  if (row.resolverOutput !== null) return "suggested";
  if (row.resolverSkipReason !== null) return "skipped";
  if (row.resolverReservedUntil !== null && row.resolverReservedUntil.getTime() > Date.now()) return "checking";
  return "waiting";
}

/**
 * Reads one page of unresolved review-queue items, oldest first.
 *
 * Returns `nextCursor` when more items follow this page, and `null` when
 * this page is the end of the queue. The caller must show the difference:
 * a list that looks complete but is not is the wrong side of TH-R10/TH-R20
 * ("uncertain beats wrong; always show the reason"), and this queue is the
 * project's named differentiator (TH-R22).
 *
 * One extra row is read and dropped — that is how this function knows
 * whether more items follow without a second `COUNT` query over the same
 * partial index.
 */
export async function listUnresolvedReviewQueue(
  db: typeof defaultDb,
  options: ListUnresolvedReviewQueueOptions = {},
): Promise<ReviewQueueListPage> {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  // A caller passing a variable limit must not be able to pass zero, a
  // negative number, or a value above the per-page ceiling straight through
  // to `.limit()` (standing rule 13: validate at the boundary; CodeRabbit
  // finding, local review round 2). TRO-507 kept this check and gave the
  // caller a cursor instead of a bigger number.
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 through ${MAX_LIST_LIMIT}.`);
  }

  const after = options.after;
  const keysetPredicate = after
    ? sql`(${reviewQueue.createdAt}, ${reviewQueue.id}) > (${after.createdAt.toISOString()}::timestamptz, ${after.id})`
    : undefined;

  const rows = await db
    .select({
      id: reviewQueue.id,
      verificationId: reviewQueue.verificationId,
      reason: reviewQueue.reason,
      createdAt: reviewQueue.createdAt,
      resolverOutput: reviewQueue.resolverOutput,
      resolverSkipReason: reviewQueue.resolverSkipReason,
      resolverReservedUntil: reviewQueue.resolverReservedUntil,
      applicationId: applications.id,
      brandName: applications.brandName,
      classType: applications.classType,
      beverageType: applications.beverageType,
      labelVerdict: verifications.verdict,
    })
    .from(reviewQueue)
    .innerJoin(verifications, eq(reviewQueue.verificationId, verifications.id))
    .innerJoin(applications, eq(verifications.applicationId, applications.id))
    .where(and(isNull(reviewQueue.disposition), keysetPredicate))
    .orderBy(asc(reviewQueue.createdAt), asc(reviewQueue.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items: ReviewQueueListItem[] = page.map((row) => ({
    id: row.id,
    verificationId: row.verificationId,
    applicationId: row.applicationId,
    reason: row.reason,
    // Same function src/app/api/verify/route.ts uses for the live "needs
    // review" flag — one sentence, one source of truth, never a second
    // hand-written copy of the wording.
    reasonText: buildFieldReasonText("NEEDS_REVIEW", row.reason, undefined),
    resolverStatus: deriveResolverStatus(row),
    brandName: row.brandName,
    classType: row.classType,
    beverageType: row.beverageType,
    labelVerdict: row.labelVerdict,
    createdAt: row.createdAt,
  }));

  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeReviewQueueCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
