/**
 * Reads every unresolved review-queue item (TRO-476, PRD §5, TH-R22): "needs-
 * human items with reason." Read-only and DB-backed, same posture as
 * `src/server/verification-detail`'s own read module (not merged as of this
 * ticket — see this module's file-level report) — it never calls a model,
 * it only shapes rows the live verify path (`src/app/api/verify/route.ts`)
 * already persisted. The cascade is the architecture (TH-R19): a read path
 * is not a place to add a second one.
 */
import { asc, eq, isNull } from "drizzle-orm";
import type { db as defaultDb } from "../../lib/db";
import { applications, reviewQueue, verifications } from "../../lib/db/schema";
import { buildFieldReasonText } from "../router/reason-text";
import type { ReviewQueueListItem } from "./types";

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
 * order in one pass is not measured here — this ticket does not fabricate
 * that number. Either way this is the one query shape the index was added
 * to serve; inventing a second query shape would not be.
 *
 * `LIMIT` (CodeRabbit local review round 1): an unbounded read of every
 * unresolved item does not scale as the queue grows, and nothing before
 * this fix stopped it from trying. 100 is a generous ceiling for a
 * prototype's realistic scale — a queue that deep would need pagination
 * as a real feature, not a bigger constant, and this ticket does not
 * invent pagination the PRD never asked for. A second `ORDER BY` key
 * (`reviewQueue.id`) makes the order deterministic even when two rows
 * share one `createdAt` — Postgres gives no ordering guarantee among rows
 * that tie on the only sort key it is given.
 */
const DEFAULT_LIST_LIMIT = 100;

export async function listUnresolvedReviewQueue(
  db: typeof defaultDb,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<ReviewQueueListItem[]> {
  const rows = await db
    .select({
      id: reviewQueue.id,
      verificationId: reviewQueue.verificationId,
      reason: reviewQueue.reason,
      createdAt: reviewQueue.createdAt,
      applicationId: applications.id,
      brandName: applications.brandName,
      classType: applications.classType,
      beverageType: applications.beverageType,
      labelVerdict: verifications.verdict,
    })
    .from(reviewQueue)
    .innerJoin(verifications, eq(reviewQueue.verificationId, verifications.id))
    .innerJoin(applications, eq(verifications.applicationId, applications.id))
    .where(isNull(reviewQueue.disposition))
    .orderBy(asc(reviewQueue.createdAt), asc(reviewQueue.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    verificationId: row.verificationId,
    applicationId: row.applicationId,
    reason: row.reason,
    // Same function src/app/api/verify/route.ts uses for the live "needs
    // review" flag — one sentence, one source of truth, never a second
    // hand-written copy of the wording.
    reasonText: buildFieldReasonText("NEEDS_REVIEW", row.reason, undefined),
    brandName: row.brandName,
    classType: row.classType,
    beverageType: row.beverageType,
    labelVerdict: row.labelVerdict,
    createdAt: row.createdAt,
  }));
}
