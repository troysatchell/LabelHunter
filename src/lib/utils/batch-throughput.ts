/**
 * Batch throughput and auto-verified share (TRO-544 / LH-039, PRD §3.8,
 * TH-R4).
 *
 * PRD §3.8, in its own words: "Batch mode is throughput-bound, not
 * latency-bound: the 5s requirement is the interactive single-label
 * promise; batch reports items/minute and per-item averages." Nothing
 * computed that number before this ticket.
 *
 * This is a DIFFERENT number from `latency-stats.ts`'s `LatencyStats`.
 * `LatencyStats` averages one EXTRACT item's own processing duration
 * (`claimed_at` to `updated_at`) — it never sees the worker pool's
 * concurrency, because five items can be claimed and processed at the same
 * wall-clock moment. `computeBatchThroughput` instead divides the whole
 * batch's real wall-clock span (`completedAt` minus `startedAt`) by
 * `totalCount` — the number the pool's concurrency actually changes. A
 * batch cannot go faster than its slowest single item's latency, but it
 * CAN finish more items per minute than `1 / latency` would suggest,
 * because several run at once. Reporting only `LatencyStats` would hide
 * that; this module is what PRD §3.8 is actually asking for.
 */

/** `totalCount / elapsed minutes`, and its reciprocal, `elapsed ms /
 * totalCount`, for one completed batch. */
export interface BatchThroughputStats {
  /** Rounded to 2 decimal places — a batch small enough to run in a
   * fraction of a minute still deserves a rate more precise than a whole
   * number (a 25-item, 90-second run is 16.67/min, not "17/min"). */
  readonly itemsPerMinute: number;
  /** Rounded to the nearest millisecond, matching `LatencyStats.avgMs`'s
   * own precision. */
  readonly avgMsPerItem: number;
}

export interface ComputeBatchThroughputParams {
  readonly totalCount: number;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

/**
 * Returns `null` — never a fabricated number (standing rules 1/2) —
 * whenever the batch has not yet finished (`startedAt`/`completedAt` not
 * both set) or has nothing to report a rate for (`totalCount <= 0`). The
 * caller shows "Not measured yet", the same convention
 * `computeLatencyStats` already established for its own `null` case.
 *
 * Throws `RangeError` when `completedAt` is not strictly after
 * `startedAt` — a `batch_jobs` row reaching `COMPLETED` with a
 * non-positive elapsed span is a caller/data bug (a clock read wrong, or
 * the two timestamps swapped), not a real "instant batch" to average into
 * a rate — mirroring `computeLatencyStats`'s own choice to throw on a
 * malformed individual input rather than silently produce `Infinity` or
 * `NaN`.
 */
export function computeBatchThroughput(params: ComputeBatchThroughputParams): BatchThroughputStats | null {
  const { totalCount, startedAt, completedAt } = params;
  if (startedAt === null || completedAt === null) return null;
  if (totalCount <= 0) return null;

  const elapsedMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new RangeError(
      `computeBatchThroughput: completedAt must be strictly after startedAt — got an elapsed span of ${elapsedMs}ms`,
    );
  }

  const itemsPerMinute = totalCount / (elapsedMs / 60_000);
  const avgMsPerItem = elapsedMs / totalCount;

  return {
    itemsPerMinute: Math.round(itemsPerMinute * 100) / 100,
    avgMsPerItem: Math.round(avgMsPerItem),
  };
}

/**
 * The share of PROCESSED labels finished without a resolver call — CP-1
 * §4.5 step 3's own definition, verbatim ("the share of labels finished
 * without a resolver call"), applied here to one batch instead of one
 * threshold sweep. `autoVerifiedCount` already carries CP-3 §7.1's
 * "decided without Sonnet or a human" meaning (`batch_jobs.auto_verified_count`,
 * `src/lib/db/schema.ts`) — this function only turns that count, and the
 * count of labels it is a share OF, into a rate.
 *
 * The denominator is `processedCount`, not `totalCount`: "labels
 * FINISHED" — a label still queued has not finished, and should not
 * silently count against the share. At `COMPLETED`, `processedCount`
 * equals `totalCount` by construction (`maybeCompleteBatchJob`,
 * `src/server/batch-queue/complete.ts`, only fires once every queue item
 * is terminal, and every terminal EXTRACT item increments
 * `processedCount` exactly once) — so this rate is already meaningful
 * WHILE a batch is still running, and does not change its denominator
 * once the batch finishes.
 *
 * Returns `null` when `processedCount` is `0` — nothing has finished yet,
 * so there is no rate to report (never a fabricated `0%`).
 *
 * Throws `RangeError` when `autoVerifiedCount` is negative or exceeds
 * `processedCount` — the same bound `batch_jobs_auto_verified_count_bounded`
 * already enforces in the database (`schema.ts`); a value outside it here
 * means a caller passed mismatched counters, not a real batch state. This
 * check runs BEFORE the `processedCount <= 0` null-return below (review
 * finding, local review round 1): checking null first would let an
 * impossible pair like `(1, 0)` — one auto-verified item out of zero
 * processed — read as "not measured yet" instead of throwing. `(0, 0)`,
 * the real "nothing processed yet" case, still returns `null`: `0` is
 * never greater than `0`.
 */
export function computeAutoVerifiedShare(autoVerifiedCount: number, processedCount: number): number | null {
  if (autoVerifiedCount < 0 || autoVerifiedCount > processedCount) {
    throw new RangeError(
      `computeAutoVerifiedShare: autoVerifiedCount (${autoVerifiedCount}) must be between 0 and processedCount (${processedCount})`,
    );
  }
  if (processedCount <= 0) return null;
  return autoVerifiedCount / processedCount;
}
