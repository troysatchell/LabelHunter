/**
 * The completion guard (LH-041 / TRO-474, CP-3 §3.2, §7.2).
 *
 * `claim.ts`'s `FOR UPDATE SKIP LOCKED` stops two workers from STARTING the
 * same item. On its own that says nothing about FINISHING it: a worker
 * whose lease expired mid-call, whose result finally does come back, must
 * not write it as if it still owned the row. Every write below is
 * conditioned on `claim_token` still matching AND `status` still being
 * `CLAIMED` — zero rows affected means this worker's claim episode is no
 * longer current, and the caller must discard its result rather than
 * reconcile it (CP-3 §3.2).
 *
 * `markDone`/`releaseForRetry`/`markFailed` all use the SAME guard shape as
 * `../review-queue/record-disposition.ts`'s own conditional UPDATE — a
 * plain Drizzle `.where(and(eq(id), eq(claimToken), eq(status, 'CLAIMED')))`
 * is enough here (no `FOR UPDATE SKIP LOCKED` needed: this is a point
 * update by primary key, not a "pick any one of many" claim).
 */
import { and, eq, notExists, sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import { batchJobs, batchQueueItems } from "../../lib/db/schema";

type Db = typeof defaultDb;
// Accepts either the shared `db` singleton or a transaction handle
// (`db.transaction(async (tx) => ...)`) — every caller that writes
// `verifications`/`fieldResults` alongside a completion runs this INSIDE
// that same transaction (CP-3 §3.2: "run this first, inside the same
// transaction that writes...").
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function claimedGuard(id: number, claimToken: string) {
  return and(eq(batchQueueItems.id, id), eq(batchQueueItems.claimToken, claimToken), eq(batchQueueItems.status, "CLAIMED"));
}

/**
 * Cap on the length of `last_error` actually written to the database. This
 * is an operational diagnostic string a human reads on a dashboard (CP-3's
 * own framing: "a human reading the last_error... naming which... case it
 * was") — not label data compared against statutory text, so
 * `resolver/input-validation.ts`'s much stricter "never truncate, reject
 * instead" rule governs a different problem, not this one. Generous enough
 * to keep a genuinely useful message (including a short SQL error detail)
 * intact; short enough to bound storage and limit how much of an upstream
 * SDK error's raw text (which this module does not otherwise inspect or
 * classify — CP-3 §8 says only that last_error "records the... message,"
 * not a structured taxonomy) ever lands in the database.
 */
export const MAX_LAST_ERROR_LENGTH = 2000;

function truncateLastError(message: string): string {
  if (message.length <= MAX_LAST_ERROR_LENGTH) return message;
  return `${message.slice(0, MAX_LAST_ERROR_LENGTH)}… (truncated, ${message.length} chars total)`;
}

/** Marks a `CLAIMED` row `DONE`. Returns `false` (and writes nothing) when
 * `claimToken` no longer matches the row's current one. */
export async function markDone(db: DbOrTx, id: number, claimToken: string): Promise<boolean> {
  const rows = await db.update(batchQueueItems).set({ status: "DONE" }).where(claimedGuard(id, claimToken)).returning({ id: batchQueueItems.id });
  return rows.length > 0;
}

/**
 * Releases a `CLAIMED` row back to `PENDING` for a later retry (CP-3 §5.2):
 * clears every claim field and pushes `availableAt` forward by `delayMs`.
 * `attempts` is left untouched — the claim query already incremented it.
 * The worker never sleeps holding the claim; it releases and moves on to
 * claim a different item immediately.
 */
export async function releaseForRetry(db: DbOrTx, id: number, claimToken: string, delayMs: number): Promise<boolean> {
  const rows = await db
    .update(batchQueueItems)
    .set({
      status: "PENDING",
      claimedBy: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      availableAt: sql`now() + (${delayMs} * interval '1 millisecond')`,
    })
    .where(claimedGuard(id, claimToken))
    .returning({ id: batchQueueItems.id });
  return rows.length > 0;
}

/** Marks a `CLAIMED` row permanently `FAILED` — attempts exhausted, or a
 * non-retryable error (CP-3 §5.1). `lastError` is the one place a failed
 * item's reason lives; it never gets a `verifications` row (CP-3 §7.3). */
export async function markFailed(db: DbOrTx, id: number, claimToken: string, lastError: string): Promise<boolean> {
  const rows = await db
    .update(batchQueueItems)
    .set({ status: "FAILED", lastError: truncateLastError(lastError), claimedBy: null, claimToken: null, claimedAt: null, leaseExpiresAt: null })
    .where(claimedGuard(id, claimToken))
    .returning({ id: batchQueueItems.id });
  return rows.length > 0;
}

/**
 * Flips a batch from `RUNNING` to `COMPLETED` once every one of its queue
 * items has reached a terminal state (CP-3 §7.2) — `DONE` or `FAILED`,
 * regardless of how many failed. `COMPLETED` says "nothing is still in
 * flight," never "everything succeeded" (CP-3 §6, Q6).
 *
 * Call this AFTER a completion write (`markDone`/`markFailed`) in the SAME
 * transaction, so the row this call just terminated is already visible to
 * the `NOT EXISTS` check below — and, for an `EXTRACT` item that just
 * escalated, so a freshly-inserted `PENDING` `RESOLVE` row is ALSO already
 * visible, correctly keeping the batch open.
 *
 * Guarded on `status = 'RUNNING'` — two workers finishing the batch's last
 * two items at once can both attempt this; Postgres's row lock on
 * `batch_jobs` serializes the two UPDATEs, so only one ever matches
 * (`complete.test.ts`'s own concurrency case proves this, not just asserts
 * it).
 */
export async function maybeCompleteBatchJob(db: DbOrTx, batchJobId: number): Promise<boolean> {
  const rows = await db
    .update(batchJobs)
    .set({ status: "COMPLETED", completedAt: sql`now()` })
    .where(
      and(
        eq(batchJobs.id, batchJobId),
        eq(batchJobs.status, "RUNNING"),
        notExists(
          db
            .select({ id: batchQueueItems.id })
            .from(batchQueueItems)
            .where(and(eq(batchQueueItems.batchJobId, batchJobId), sql`${batchQueueItems.status} NOT IN ('DONE', 'FAILED')`)),
        ),
      ),
    )
    .returning({ id: batchJobs.id });
  return rows.length > 0;
}
