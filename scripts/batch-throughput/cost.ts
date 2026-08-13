/**
 * Derives one batch run's dollar cost estimate (TRO-544 / LH-039). The
 * inputs: one observed call count, one attempts-derived upper bound, and
 * the eval harness's measured mean per-call costs.
 *
 * The result is a DERIVED ESTIMATE, not a measurement. The batch worker
 * (`src/server/batch-queue/`) records no per-call token usage. That seam
 * exists only in the eval harness (`scripts/eval/usage.ts`, whose
 * `createUsageCapturingClient` reads `response.usage` on every call).
 * CLAUDE.md: "never fabricate a number." The Sonnet count is a real
 * count from this run's own `batch_jobs` row. The Haiku count is an
 * UPPER BOUND from this run's own `batch_queue_items.attempts`. The
 * means are real prior measurements from
 * `scripts/eval/results/eval-report.json`. Only the multiplication is
 * new, so the estimate can overstate the Haiku side and cannot
 * understate it.
 */

/** Arithmetic mean of a list of real, measured per-call costs. Throws on
 * an empty list — there is no mean of zero real calls, and `0` would read
 * as a real answer instead of a missing one (standing rules 1/2). Throws
 * on any element that is not finite or is negative (review finding, local
 * review round 2) — a real USD cost is never negative, and a corrupted
 * `eval-report.json` entry (`NaN`, `null` coerced to `0`, `Infinity`) must
 * fail loudly here rather than silently skew every mean it feeds into. */
export function meanCost(costsUsd: readonly number[]): number {
  if (costsUsd.length === 0) {
    throw new RangeError("meanCost: costsUsd must be non-empty — there is no mean of zero real calls");
  }
  const badIndex = costsUsd.findIndex((c) => !Number.isFinite(c) || c < 0);
  if (badIndex !== -1) {
    throw new RangeError(`meanCost: costsUsd must contain only finite, non-negative numbers — index ${badIndex} is ${costsUsd[badIndex]}`);
  }
  const mean = costsUsd.reduce((sum, cost) => sum + cost, 0) / costsUsd.length;
  // Finite inputs can still overflow the SUM to Infinity. An artifact
  // must never carry that: JSON.stringify(Infinity) serializes as null,
  // which would read as "no cost" (review finding, local review round 7).
  if (!Number.isFinite(mean)) {
    throw new RangeError(`meanCost: result is not finite (${mean}) — the cost sum overflowed`);
  }
  return mean;
}

export interface DeriveBatchCostParams {
  readonly haikuCallCount: number;
  readonly haikuMeanCostUsd: number;
  readonly sonnetCallCount: number;
  readonly sonnetMeanCostUsd: number;
}

/**
 * `(haikuCallCount * haikuMeanCostUsd) + (sonnetCallCount * sonnetMeanCostUsd)`.
 * `haikuCallCount` is an UPPER BOUND on real Haiku calls, not a call
 * count. It sums extraction claim ATTEMPTS (`measure.ts`'s own
 * computation). A retry adds one attempt. An attempt that fails before
 * its request — an unreadable or unresizable image — also adds one, with
 * zero real calls made. The derived total can therefore overstate the
 * Haiku side; it cannot understate it. `sonnetCallCount` is a real call
 * count: `batch_jobs.sonnet_call_count` counts first attempts and
 * retries alike (`escalation-cap.ts`'s own doc comment).
 *
 * Throws `RangeError` on a call count that is not a non-negative safe
 * integer, or a mean cost that is not finite (review finding, local
 * review round 3) — `Number.isSafeInteger`, not a bare `< 0` check: a
 * `< 0` comparison against `NaN` is always `false`, so `NaN` silently
 * passed the round-2 version of this check and would have produced a
 * `NaN` total instead of a thrown error.
 */
export function deriveBatchCostUsd(params: DeriveBatchCostParams): number {
  const { haikuCallCount, haikuMeanCostUsd, sonnetCallCount, sonnetMeanCostUsd } = params;
  if (!Number.isSafeInteger(haikuCallCount) || haikuCallCount < 0 || !Number.isSafeInteger(sonnetCallCount) || sonnetCallCount < 0) {
    throw new RangeError(
      `deriveBatchCostUsd: call counts must be non-negative safe integers — got haikuCallCount=${haikuCallCount}, sonnetCallCount=${sonnetCallCount}`,
    );
  }
  if (!Number.isFinite(haikuMeanCostUsd) || haikuMeanCostUsd < 0 || !Number.isFinite(sonnetMeanCostUsd) || sonnetMeanCostUsd < 0) {
    throw new RangeError(
      `deriveBatchCostUsd: mean costs must be finite and non-negative — got haikuMeanCostUsd=${haikuMeanCostUsd}, sonnetMeanCostUsd=${sonnetMeanCostUsd}`,
    );
  }
  const total = haikuCallCount * haikuMeanCostUsd + sonnetCallCount * sonnetMeanCostUsd;
  // Same overflow guard as meanCost: a huge count times a finite mean can
  // reach Infinity, and JSON.stringify(Infinity) writes null into the
  // artifact — a silent "no cost" (review finding, local review round 7).
  if (!Number.isFinite(total)) {
    throw new RangeError(`deriveBatchCostUsd: result is not finite (${total}) — a count times a mean overflowed`);
  }
  return total;
}
