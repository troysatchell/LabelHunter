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
 * Every Haiku extraction ATTEMPT counts — `haikuCallCount` is a sum of
 * real attempts, not a bare label count, so a retried extraction is
 * priced as more than one call (`measure.ts`'s own `haikuCallCount`
 * computation). Every Sonnet call ATTEMPT counts too (`sonnetCallCount` —
 * `batch_jobs.sonnet_call_count`, which already counts a retry the same
 * way `escalation-cap.ts`'s own doc comment requires: "first attempts and
 * retries alike").
 *
 * Throws `RangeError` on a negative call count or a non-finite mean cost
 * (review finding, local review round 2) — the same defensive-boundary
 * discipline `meanCost` above already applies to its own input.
 */
export function deriveBatchCostUsd(params: DeriveBatchCostParams): number {
  const { haikuCallCount, haikuMeanCostUsd, sonnetCallCount, sonnetMeanCostUsd } = params;
  if (haikuCallCount < 0 || sonnetCallCount < 0) {
    throw new RangeError(`deriveBatchCostUsd: call counts must be non-negative — got haikuCallCount=${haikuCallCount}, sonnetCallCount=${sonnetCallCount}`);
  }
  if (!Number.isFinite(haikuMeanCostUsd) || !Number.isFinite(sonnetMeanCostUsd)) {
    throw new RangeError(
      `deriveBatchCostUsd: mean costs must be finite — got haikuMeanCostUsd=${haikuMeanCostUsd}, sonnetMeanCostUsd=${sonnetMeanCostUsd}`,
    );
  }
  return haikuCallCount * haikuMeanCostUsd + sonnetCallCount * sonnetMeanCostUsd;
}
