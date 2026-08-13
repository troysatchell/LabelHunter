/**
 * The resolver's atomic reservation (TRO-506 / TRO-512, CP-3 §3.3 and §12
 * open question 2).
 *
 * TRO-506 found a check-then-call-then-write race in `resolveEscalatedLabel`:
 * two callers for one `verificationId` both read "no row yet", both pay for
 * a real Sonnet call, and only one write survives. The unique index on
 * `review_queue.verification_id` protects the DATA; nothing protected the
 * MONEY. CP-3 §3.3 prescribes the fix — take an atomic per-verification
 * reservation BEFORE the model call, so exactly one caller ever calls
 * Sonnet:
 *
 *     INSERT INTO review_queue (verification_id, reason)
 *     VALUES (...) ON CONFLICT (verification_id) DO NOTHING RETURNING id
 *
 * **Why this module writes `DO UPDATE ... WHERE`, not `DO NOTHING`.** CP-3
 * §3.3 hands two questions to this ticket that a bare `DO NOTHING` cannot
 * answer:
 *
 * 1. `review_queue` has no expiry of its own, so a reservation left behind
 *    by a caller that dies between reserving and calling Sonnet has nothing
 *    to reclaim it (CP-3's own words). This module answers that with a
 *    lease on the reservation itself — `resolver_reserved_until` — and lets
 *    a later caller take over an expired one.
 * 2. TRO-511 shipped after CP-3 was written. The single-label verify route
 *    now pre-files a bare `review_queue` row at verify time, so a row
 *    already exists before `resolveEscalatedLabel` ever runs. Under a bare
 *    `DO NOTHING`, every single-label escalation would look "already
 *    reserved" and no caller would ever resolve it.
 *
 * The `WHERE` clause keeps CP-3's guarantee exactly: it matches only a row
 * that is unresolved, unskipped, and not under a live reservation. While
 * another caller holds a live reservation the statement updates nothing and
 * returns nothing — `DO NOTHING`, in the one state CP-3 cares about.
 */
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import type { ReviewReason } from "../router/types";
import { isResolverResolution, type ResolverDb } from "./queue";
import type { ResolverResolution } from "./types";

/**
 * How long one caller's reservation holds off every other caller, in
 * seconds. 120 is CP-3 §3.2's own lease length for a `RESOLVE` batch item,
 * reused rather than re-invented, and it is twice `index.ts`'s
 * `DEFAULT_CLIENT_TIMEOUT_MS` (60 s) — the longest a Sonnet call this repo
 * makes can run before the SDK gives up. A reservation therefore outlives
 * the call it protects, with margin. Not measured against a real slow call;
 * it is a bound, not an observation.
 */
export const RESERVATION_LEASE_SECONDS = 120;

/**
 * How many times `reserveReviewQueueEntry` re-runs its own two statements
 * before giving up. One retry covers the only interleaving that needs it:
 * the reservation was live when the upsert ran and free again when the read
 * ran, a microsecond later. Three attempts is a bound on a pathological
 * loop, not a measured number.
 */
const MAX_RESERVE_ATTEMPTS = 3;

/** What `reserveReviewQueueEntry` and `readReviewQueueReservation` can find
 * for one `verificationId`. A discriminated union (standing rule 19), so a
 * caller cannot read `resolverOutput` without first proving the row carries
 * one. */
export type ReviewQueueReservation =
  /** This caller now owns the reservation and must perform the Sonnet call. */
  | { kind: "reserved"; id: number }
  /** Another caller already produced a full resolution. Reuse it; call
   * nothing. */
  | { kind: "resolved"; id: number; resolverOutput: ResolverResolution }
  /** Another caller holds a live reservation and is calling Sonnet right
   * now. Wait for its result; never start a second call. */
  | { kind: "held"; id: number; reservedUntil: Date };

/** What `readReviewQueueReservation` sees, plus the one state
 * `reserveReviewQueueEntry` never returns: nothing is holding this
 * verification, so the next reservation attempt will win it. */
export type ReviewQueueReservationState = ReviewQueueReservation | { kind: "free" };

export interface ReserveReviewQueueEntryParams {
  verificationId: number;
  /** The label's headline `ReviewReason`, written only when this call
   * inserts the row. An existing row keeps the `reason` its own writer
   * gave it. */
  reason: ReviewReason;
  /** Overrides `RESERVATION_LEASE_SECONDS`. Tests use a short lease to
   * exercise take-over of an expired reservation. */
  leaseSeconds?: number;
}

function assertPositiveFinite(name: string, value: number): void {
  // Standing rule 13: validate at the boundary. A zero or negative lease
  // would produce a reservation that is expired the instant it commits —
  // an atomic reservation that reserves nothing.
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than 0, got ${value}.`);
  }
}

/**
 * Reads what currently holds this verification, without writing anything.
 * A waiter polls with this rather than re-running the reservation upsert:
 * a conflicting INSERT still consumes an identity value, and a waiter can
 * poll many times.
 *
 * Throws on a row whose `resolverOutput` is non-null but does not match
 * this module's `ResolverResolution` shape — the same refusal
 * `findExistingReviewQueueEntry` makes for the same data, for the same
 * reason: unrecognized data is rejected, never guessed at.
 */
export async function readReviewQueueReservation(verificationId: number, db: ResolverDb = defaultDb): Promise<ReviewQueueReservationState> {
  const row = await db.query.reviewQueue.findFirst({
    where: (rq, { eq }) => eq(rq.verificationId, verificationId),
  });
  if (!row) return { kind: "free" };

  if (row.resolverOutput !== null) {
    if (!isResolverResolution(row.resolverOutput)) {
      throw new Error(
        `readReviewQueueReservation: verification ${verificationId} already has a review_queue row (id ${row.id}) ` +
          "whose resolverOutput does not match this module's ResolverResolution shape — refusing to reuse it or to " +
          "silently re-run the model behind the unique constraint's back.",
      );
    }
    return { kind: "resolved", id: row.id, resolverOutput: row.resolverOutput };
  }

  if (row.resolverSkipReason !== null) {
    // A deliberate skip (the batch escalation cap, CP-3 §6.2) is a finished
    // row that will never carry a resolution. Reporting it as "held" would
    // make a caller wait for a resolution that is never coming, so this
    // module refuses instead — the same refusal
    // `findExistingReviewQueueEntry` already makes for this row shape.
    throw new Error(
      `readReviewQueueReservation: verification ${verificationId} has a review_queue row (id ${row.id}) that was ` +
        `deliberately skipped ("${row.resolverSkipReason}"). Sonnet must not run for it.`,
    );
  }

  const reservedUntil = row.resolverReservedUntil;
  if (reservedUntil !== null && reservedUntil.getTime() > Date.now()) {
    return { kind: "held", id: row.id, reservedUntil };
  }
  return { kind: "free" };
}

/**
 * Takes the reservation for one verification, or reports who holds it.
 *
 * One `INSERT ... ON CONFLICT ... RETURNING` statement decides the winner —
 * Postgres serializes it, so two concurrent callers cannot both win. See
 * this module's header for why the conflict action is `DO UPDATE ... WHERE`
 * rather than `DO NOTHING`.
 */
export async function reserveReviewQueueEntry(
  params: ReserveReviewQueueEntryParams,
  db: ResolverDb = defaultDb,
): Promise<ReviewQueueReservation> {
  const leaseSeconds = params.leaseSeconds ?? RESERVATION_LEASE_SECONDS;
  assertPositiveFinite("reserveReviewQueueEntry: leaseSeconds", leaseSeconds);

  for (let attempt = 1; attempt <= MAX_RESERVE_ATTEMPTS; attempt += 1) {
    const result = await db.execute<{ id: number }>(sql`
      INSERT INTO review_queue (verification_id, reason, resolver_reserved_until)
      VALUES (${params.verificationId}, ${params.reason}, now() + (${leaseSeconds} * interval '1 second'))
      ON CONFLICT (verification_id) DO UPDATE
        SET resolver_reserved_until = now() + (${leaseSeconds} * interval '1 second')
        WHERE review_queue.resolver_output IS NULL
          AND review_queue.resolver_skip_reason IS NULL
          AND (review_queue.resolver_reserved_until IS NULL OR review_queue.resolver_reserved_until <= now())
      RETURNING id
    `);
    const row = result.rows[0];
    if (row) return { kind: "reserved", id: row.id };

    const state = await readReviewQueueReservation(params.verificationId, db);
    if (state.kind !== "free") return state;
    // The holder released or finished between the two statements above.
    // Try to win it.
  }

  throw new Error(
    `reserveReviewQueueEntry: verification ${params.verificationId} was neither reservable nor reserved after ` +
      `${MAX_RESERVE_ATTEMPTS} attempts. Another caller is taking and releasing the reservation in a tight loop.`,
  );
}

/**
 * Releases a reservation this caller owns but will not fill — the Sonnet
 * call threw, so the next caller (a worker retry, a sibling worker) must be
 * able to take the reservation immediately instead of waiting out the full
 * lease.
 *
 * Guarded on the row still being unresolved and unskipped: a release must
 * never touch a row a competing caller already finished.
 */
export async function releaseReviewQueueReservation(id: number, db: ResolverDb = defaultDb): Promise<boolean> {
  const result = await db.execute<{ id: number }>(sql`
    UPDATE review_queue
    SET resolver_reserved_until = NULL
    WHERE id = ${id}
      AND resolver_output IS NULL
      AND resolver_skip_reason IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}
