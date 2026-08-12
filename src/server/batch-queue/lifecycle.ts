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
 * pairing. `ON CONFLICT ... DO NOTHING` against
 * `batch_queue_items_extract_pairing_unique` (`schema.ts`) makes this
 * idempotent: a retried batch-creation step (a client timeout, a partial
 * failure) reuses the existing rows instead of duplicating them — which
 * matters concretely, because `verifications` carries no unique constraint
 * on `(applicationId, labelImageId)` either, so a duplicate `EXTRACT` row
 * would not just waste a claim slot, it would let the SAME label run the
 * cascade twice and double-count itself downstream (CP-3 §2.2).
 *
 * Returns the number of rows ACTUALLY inserted (excludes ones a conflict
 * skipped) — callers that want to confirm "every pairing is now queued"
 * should compare this against `pairings.length` only loosely: a smaller
 * number on a retry is the expected, correct idempotent outcome, not an
 * error.
 */
export async function enqueueExtractItems(db: DbOrTx, batchJobId: number, pairings: ExtractPairing[]): Promise<number> {
  if (pairings.length === 0) return 0;
  const rows = await db
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
  return rows.length;
}
