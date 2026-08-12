/**
 * Batch lifecycle plumbing (LH-041 / TRO-474, CP-3 §2.2, §8 steps 1–2).
 *
 * These two functions are the hook a future upload handler (LH-040) calls
 * — `startBatchJob` once pairing succeeds and the job is ready to run,
 * `enqueueExtractItems` to seed the `EXTRACT` queue. Neither is CSV
 * parsing, filename pairing, or an HTTP route — this ticket owns the
 * `batch_queue_items` table and the claim query's own precondition
 * (`batch_jobs.status = 'RUNNING'`, `claim.ts`), so the two smallest
 * functions that satisfy that precondition live here rather than being
 * invented ad hoc later. What this does NOT do: CP-1 §7.3's warm-up
 * request (a live Anthropic call, out of scope for queue plumbing) — a
 * future caller sequences that between `enqueueExtractItems` and
 * `startBatchJob`, per CP-3 §8 step 2.
 */
import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import { batchJobs, batchQueueItems } from "../../lib/db/schema";

type Db = typeof defaultDb;
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Flips a batch from `PENDING` to `RUNNING` (CP-3 §8 step 2). Guarded on
 * `status = 'PENDING'` — a second call (a retried request) is a safe
 * no-op, not a double-start. */
export async function startBatchJob(db: DbOrTx, batchJobId: number): Promise<boolean> {
  const rows = await db
    .update(batchJobs)
    .set({ status: "RUNNING", startedAt: sql`now()` })
    .where(and(eq(batchJobs.id, batchJobId), eq(batchJobs.status, "PENDING")))
    .returning({ id: batchJobs.id });
  return rows.length > 0;
}

export interface ExtractPairing {
  applicationId: number;
  labelImageId: number;
}

/**
 * Enqueues one `EXTRACT` `batch_queue_items` row per (application, image)
 * pairing, and keeps `batch_jobs.total_count` in step with what actually
 * got enqueued — in the SAME transaction, so a crash between the two
 * writes leaves neither committed rather than a batch whose `total_count`
 * permanently undercounts its own queue. `ON CONFLICT ... DO NOTHING`
 * against `batch_queue_items_extract_pairing_unique` (`schema.ts`) makes
 * the enqueue itself idempotent: a retried batch-creation step (a client
 * timeout, a partial failure) reuses the existing rows instead of
 * duplicating them — which matters concretely, because `verifications`
 * carries no unique constraint on `(applicationId, labelImageId)` either,
 * so a duplicate `EXTRACT` row would not just waste a claim slot, it would
 * let the SAME label run the cascade twice and double-count itself
 * downstream (CP-3 §2.2).
 *
 * `total_count` is incremented by the number of rows THIS call actually
 * inserted, not by `pairings.length` — a retry that re-submits pairings
 * already enqueued must add zero to `total_count`, not double-count them
 * (`lifecycle.test.ts`'s own idempotent-retry case proves this).
 *
 * Returns that same actually-inserted count — callers that want to
 * confirm "every pairing is now queued" should compare this against
 * `pairings.length` only loosely: a smaller number on a retry is the
 * expected, correct idempotent outcome, not an error.
 *
 * Requires `batch_jobs.status = 'PENDING'`, locked `FOR UPDATE` for the
 * life of the transaction — the module comment above states the intended
 * call order plainly: enqueue while PENDING, THEN `startBatchJob` flips it
 * to RUNNING. The lock serializes against a concurrent `startBatchJob` call
 * racing for the same row, and the status check rejects a caller bug
 * (enqueueing into a batch that already started, completed, or failed)
 * rather than silently inflating `total_count` for items the claim query
 * (`claim.ts`, scoped to `status = 'RUNNING'`) would never pick up, or that
 * would be enqueued after the batch already reported itself COMPLETED
 * (standing rule 13: validate at the boundary where a caller's assumed
 * state is not guaranteed).
 */
export async function enqueueExtractItems(db: DbOrTx, batchJobId: number, pairings: ExtractPairing[]): Promise<number> {
  if (pairings.length === 0) return 0;
  return db.transaction(async (tx) => {
    const [job] = await tx.select({ status: batchJobs.status }).from(batchJobs).where(eq(batchJobs.id, batchJobId)).for("update");
    if (!job) {
      throw new Error(`enqueueExtractItems: batch job ${batchJobId} does not exist`);
    }
    if (job.status !== "PENDING") {
      throw new Error(
        `enqueueExtractItems: batch job ${batchJobId} is ${job.status}, not PENDING — cannot enqueue EXTRACT items into a batch that has already started, completed, or failed`,
      );
    }

    const rows = await tx
      .insert(batchQueueItems)
      .values(
        pairings.map((p) => ({
          batchJobId,
          kind: "EXTRACT" as const,
          applicationId: p.applicationId,
          labelImageId: p.labelImageId,
        })),
      )
      .onConflictDoNothing({
        target: [batchQueueItems.batchJobId, batchQueueItems.applicationId, batchQueueItems.labelImageId],
        where: sql`${batchQueueItems.kind} = 'EXTRACT'`,
      })
      .returning({ id: batchQueueItems.id });

    if (rows.length > 0) {
      await tx
        .update(batchJobs)
        .set({ totalCount: sql`${batchJobs.totalCount} + ${rows.length}` })
        .where(eq(batchJobs.id, batchJobId));
    }
    return rows.length;
  });
}
