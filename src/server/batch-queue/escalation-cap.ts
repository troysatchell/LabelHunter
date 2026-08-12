/**
 * The per-batch Sonnet escalation cap (LH-041 / TRO-474, CP-3 §6 — this
 * settles CP-1's own deferred open question 6).
 *
 * The cap bounds Sonnet call ATTEMPTS, not settled outcomes (CP-3 §6.2's
 * own correction to an earlier draft): a `RESOLVE` item that exhausts
 * every retry increments neither `resolvedBySonnetCount` nor
 * `needsHumanCount`, so counting only those two would let a batch where
 * every Sonnet attempt happens to fail burn unlimited real-money calls
 * while the threshold check never trips. `reserveSonnetCall` must run
 * before EVERY call attempt — first try and every retry alike.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import { batchJobs } from "../../lib/db/schema";

type Db = typeof defaultDb;
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Proposed, not measured (CP-3 §6.1, adopting CP-1 Q7's own number).
 * `Math.ceil`, not `Math.floor` or a plain division: a floor of ONE call
 * of budget for any batch with at least one item — a 1-label batch's "25%
 * cap" is 100%, a 3-label batch's is 33% (`ceil(0.75) = 1`) — invisible at
 * TH-R4's own 200–300 label scale, where 25% of 300 is a plain 75. */
export const SONNET_ESCALATION_CAP_FRACTION = 0.25;

export function computeSonnetCallCapThreshold(totalCount: number): number {
  return Math.ceil(SONNET_ESCALATION_CAP_FRACTION * totalCount);
}

/** The one `resolverSkipReason` value this ticket produces (CP-3 §6.2/§6.4)
 * — passed to `../resolver/queue.ts`'s `insertSkippedReviewQueueEntry`. */
export const ESCALATION_CAP_EXCEEDED_SKIP_REASON = "ESCALATION_CAP_EXCEEDED";

/**
 * Atomically reserves one unit of this batch's Sonnet call budget. Returns
 * `true` (and increments `sonnet_call_count`) when the batch is still
 * under `capThreshold`; `false` (no write) when the budget is exhausted.
 *
 * One `UPDATE ... WHERE sonnet_call_count < capThreshold RETURNING`
 * statement — Postgres serializes concurrent UPDATEs to the same row, so
 * two resolve-workers racing this check cannot both read "under budget"
 * and both proceed (`escalation-cap.test.ts`'s own concurrency case proves
 * this against a real database, not just asserts it). There is no
 * overshoot to bound; the cap is exact.
 */
export async function reserveSonnetCall(db: DbOrTx, batchJobId: number, capThreshold: number): Promise<boolean> {
  const rows = await db
    .update(batchJobs)
    .set({ sonnetCallCount: sql`${batchJobs.sonnetCallCount} + 1` })
    .where(and(eq(batchJobs.id, batchJobId), lt(batchJobs.sonnetCallCount, capThreshold)))
    .returning({ id: batchJobs.id });
  return rows.length > 0;
}
