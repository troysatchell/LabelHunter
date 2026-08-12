/**
 * The atomic claim primitive for single-label-originated `review_queue`
 * rows (TRO-511, CP-3 §9/§12 open question 5). Mirrors
 * `../batch-queue/claim.ts`'s `claimNextBatchQueueItem` shape closely — the
 * same `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)
 * RETURNING *` statement, the same fresh-`claim_token`-every-claim fencing
 * mechanism, the same lease-expiry recovery — applied to `review_queue`
 * instead of `batch_queue_items`, because that table's `batch_job_id` is
 * `NOT NULL` and its claim query's own `JOIN batch_jobs ... WHERE
 * bj.status = 'RUNNING'` is load-bearing for the batch design (CP-3 §3.1).
 * Widening it to also cover a batch-less row would touch shared,
 * already-tested batch-worker infrastructure for a case that table was
 * never designed to hold — a new, small, dedicated claim query against the
 * table that already carries every column this needs is the smaller,
 * safer change (see `schema.ts`'s own doc comment on `reviewQueue`).
 *
 * **"Batch job is absent" (CP-3 §12 Q5's own predicate) is exactly
 * `resolver_input IS NOT NULL`.** Only `app/api/verify/route.ts` ever sets
 * that column — `insertReviewQueueEntry`/`insertSkippedReviewQueueEntry`
 * (the batch path's own writers, via `resolveEscalatedLabel` or the
 * escalation-cap skip) never do. A batch-originated row can therefore never
 * satisfy this claim query's `WHERE` clause, with no separate `NOT EXISTS`
 * check against `batch_queue_items` needed.
 *
 * No `status` enum column exists here the way `batch_queue_items` has one
 * (CP-3 §2.2) — `review_queue`'s own `resolverOutput`/`resolverSkipReason`
 * already say "done" the moment either is set, so "claimable" is exactly
 * "not done, has a snapshot, past its available time, and not currently
 * leased" — one fewer piece of state to keep in sync.
 */
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";

type Db = typeof defaultDb;

export interface ClaimedReviewQueueResolveItem {
  id: number;
  verificationId: number;
  resolverInput: unknown;
  claimedBy: string | null;
  claimToken: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  availableAt: Date;
  attempts: number;
}

/** Raw shape a `RETURNING *` on `review_queue` hands back — Postgres's own
 * snake_case column names, the columns this module's claim actually needs
 * (not every column the table has). Verified empirically (not assumed,
 * same note `../batch-queue/claim.ts` makes): `db.execute()`'s raw path
 * returns `timestamptz` columns as ISO strings, not pre-parsed `Date`
 * objects the way Drizzle's own query builder does — `mapRow` does that
 * parsing explicitly. */
interface RawReviewQueueRow {
  [column: string]: unknown;
  id: number;
  verification_id: number;
  resolver_input: unknown;
  claimed_by: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  available_at: string;
  attempts: number;
}

function toDate(value: string): Date;
function toDate(value: string | null): Date | null;
function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function mapRow(row: RawReviewQueueRow): ClaimedReviewQueueResolveItem {
  return {
    id: row.id,
    verificationId: row.verification_id,
    resolverInput: row.resolver_input,
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    claimedAt: toDate(row.claimed_at),
    leaseExpiresAt: toDate(row.lease_expires_at),
    availableAt: toDate(row.available_at),
    attempts: row.attempts,
  };
}

export interface ClaimNextReviewQueueResolveItemOptions {
  /** Test-only narrowing filter — production callers never set this.
   * `review_queue` has no grouping FK a claim query can scope a JOIN
   * against the way `../batch-queue/claim.ts` scopes to one `batchJobId`;
   * this is the equivalent guard against cross-test-file flake under
   * vitest's default parallel file execution (same reasoning as that
   * module's own `scopeToBatchJobId` doc comment). Production behavior is
   * unaffected either way — the real worker claims from the WHOLE table. */
  scopeToVerificationIds?: number[];
}

/**
 * Claims the next available single-label-originated `review_queue` row, or
 * `null` if none is available right now. One UPDATE statement — see the
 * module comment for why that matters.
 */
export async function claimNextReviewQueueResolveItem(
  db: Db,
  workerId: string,
  leaseSeconds: number,
  maxAttempts: number,
  options: ClaimNextReviewQueueResolveItemOptions = {},
): Promise<ClaimedReviewQueueResolveItem | null> {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    // Standing rule 13: validate at the boundary — same reasoning as
    // `../batch-queue/claim.ts`'s identical guard.
    throw new RangeError(`claimNextReviewQueueResolveItem: leaseSeconds must be a finite number > 0, got ${leaseSeconds}`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError(`claimNextReviewQueueResolveItem: maxAttempts must be a positive integer, got ${maxAttempts}`);
  }

  // Drizzle serializes a plain array parameter as its OWN parenthesized
  // list (`($4, $5, ...)`) — `IN ${array}` therefore renders as valid
  // `IN ($4, $5, ...)`; wrapping it in a second, manual set of parens (as
  // `= ANY(${array})` would) produces an invalid doubly-parenthesized
  // `ANY((...))`, verified empirically against this worktree's own
  // Postgres (caught by this file's own concurrency tests, not assumed).
  const verificationScope =
    options.scopeToVerificationIds !== undefined && options.scopeToVerificationIds.length > 0
      ? sql`AND rq.verification_id IN ${options.scopeToVerificationIds}`
      : sql``;

  const result = await db.execute<RawReviewQueueRow>(sql`
    UPDATE review_queue
    SET claimed_by = ${workerId},
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
        attempts = attempts + 1
    WHERE id = (
      SELECT rq.id FROM review_queue rq
      WHERE rq.resolver_output IS NULL
        AND rq.resolver_skip_reason IS NULL
        AND rq.resolver_input IS NOT NULL
        AND rq.attempts < ${maxAttempts}
        AND rq.available_at <= now()
        AND (rq.claim_token IS NULL OR rq.lease_expires_at < now())
        ${verificationScope}
      ORDER BY rq.id
      FOR UPDATE OF rq SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, verification_id, resolver_input, claimed_by, claim_token, claimed_at, lease_expires_at, available_at, attempts
  `);

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}
