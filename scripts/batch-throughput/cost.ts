/**
 * Derives one batch run's real dollar cost from real call counts and the
 * eval harness's own measured mean per-call cost (TRO-544 / LH-039).
 *
 * This is DERIVED, not measured: the batch worker
 * (`src/server/batch-queue/`) records no per-call token usage, unlike the
 * eval harness's own `scripts/eval/usage.ts` (`createUsageCapturingClient`
 * wraps a real `Anthropic` client to read `response.usage` on every call —
 * that seam exists only in the eval harness). CLAUDE.md: "never fabricate
 * a number" — every input to `deriveBatchCostUsd` is either a real count
 * from this run's own `batch_jobs` row, or a real prior measurement from
 * `scripts/eval/results/eval-report.json`; only the multiplication itself
 * is new.
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
  return costsUsd.reduce((sum, cost) => sum + cost, 0) / costsUsd.length;
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
  return haikuCallCount * haikuMeanCostUsd + sonnetCallCount * sonnetMeanCostUsd;
}
