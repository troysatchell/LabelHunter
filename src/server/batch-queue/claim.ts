/**
 * The atomic claim primitive (LH-041 / TRO-474, CP-3 §3.1).
 *
 * A worker never runs "find a row" then "mark it mine" as two queries —
 * that shape is a race by construction. This is one statement: Postgres's
 * own `FOR UPDATE SKIP LOCKED` locks the one candidate row it picks, and
 * any other worker running the same statement at the same instant simply
 * skips past a row someone else already has locked. Two workers cannot
 * land on the same row — Postgres enforces that, not application code
 * (`claim.test.ts`'s own concurrency suite proves it against a real
 * database, not an assumption about how the SQL should behave).
 *
 * `bj.status = 'RUNNING'` is not decoration: without it, a worker could
 * claim item 1 before a batch's own warm-up/start step has run (CP-3 §3.1,
 * §8 step 2–3).
 */
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import type { BatchQueueItemKind, BatchQueueItemStatus } from "../../lib/db/enums";

type Db = typeof defaultDb;

export interface ClaimedBatchQueueItem {
  id: number;
  batchJobId: number;
  kind: BatchQueueItemKind;
  applicationId: number | null;
  labelImageId: number | null;
  verificationId: number | null;
  resolverInput: unknown;
  status: BatchQueueItemStatus;
  claimedBy: string | null;
  claimToken: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  availableAt: Date;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Raw shape a `RETURNING *` on `batch_queue_items` hands back — Postgres's
 * own snake_case column names. Verified empirically (not assumed) that
 * `db.execute()`'s raw path returns `timestamptz` columns as ISO strings,
 * NOT pre-parsed `Date` objects the way Drizzle's own query builder returns
 * them — `mapRow` below does that parsing explicitly.
 */
interface RawBatchQueueItemRow {
  [column: string]: unknown;
  id: number;
  batch_job_id: number;
  kind: BatchQueueItemKind;
  application_id: number | null;
  label_image_id: number | null;
  verification_id: number | null;
  resolver_input: unknown;
  status: BatchQueueItemStatus;
  claimed_by: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  available_at: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toDate(value: string): Date;
function toDate(value: string | null): Date | null;
function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function mapRow(row: RawBatchQueueItemRow): ClaimedBatchQueueItem {
  return {
    id: row.id,
    batchJobId: row.batch_job_id,
    kind: row.kind,
    applicationId: row.application_id,
    labelImageId: row.label_image_id,
    verificationId: row.verification_id,
    resolverInput: row.resolver_input,
    status: row.status,
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    claimedAt: toDate(row.claimed_at),
    leaseExpiresAt: toDate(row.lease_expires_at),
    availableAt: toDate(row.available_at),
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export interface ClaimNextBatchQueueItemOptions {
  /**
   * Test-only narrowing filter — production callers never set this. The
   * real worker pool claims from the WHOLE `kind` queue across every
   * running batch (CP-3 §3.1's own SQL has no `batchJobId` filter, by
   * design: one pool serves the whole system, not one batch at a time).
   * Vitest runs different test FILES in parallel by default; without this,
   * two test files each running their own concurrency assertions against
   * this same global queue could legitimately claim each other's fixture
   * rows. Scoping by `batchJobId` in tests only removes that cross-file
   * flake risk — it changes nothing about production behavior.
   */
  scopeToBatchJobId?: number;
}

/**
 * Claims the next available `batch_queue_items` row of `kind`, or `null`
 * if none is available right now. One UPDATE statement — see the module
 * comment for why that matters.
 */
export async function claimNextBatchQueueItem(
  db: Db,
  kind: BatchQueueItemKind,
  workerId: string,
  leaseSeconds: number,
  options: ClaimNextBatchQueueItemOptions = {},
): Promise<ClaimedBatchQueueItem | null> {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    // Standing rule 13: validate at the boundary. A bad value here (0,
    // negative, NaN, Infinity) would build a nonsense or rejected SQL
    // interval — better an immediate, readable throw than a lease that
    // expires in the past (or never) and silently breaks CP-3 §3.2's
    // recovery path.
    throw new RangeError(`claimNextBatchQueueItem: leaseSeconds must be a finite number > 0, got ${leaseSeconds}`);
  }

  const batchScope =
    options.scopeToBatchJobId !== undefined ? sql`AND bqi.batch_job_id = ${options.scopeToBatchJobId}` : sql``;

  const result = await db.execute<RawBatchQueueItemRow>(sql`
    UPDATE batch_queue_items
    SET status = 'CLAIMED',
        claimed_by = ${workerId},
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
        attempts = attempts + 1
    WHERE id = (
      SELECT bqi.id FROM batch_queue_items bqi
      JOIN batch_jobs bj ON bj.id = bqi.batch_job_id
      WHERE bqi.kind = ${kind}::batch_queue_item_kind
        AND bj.status = 'RUNNING'
        AND bqi.available_at <= now()
        AND (bqi.status = 'PENDING' OR (bqi.status = 'CLAIMED' AND bqi.lease_expires_at < now()))
        ${batchScope}
      ORDER BY bqi.id
      FOR UPDATE OF bqi SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}
