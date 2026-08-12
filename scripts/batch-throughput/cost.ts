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
 * as a real answer instead of a missing one (standing rules 1/2). */
export function meanCost(costsUsd: readonly number[]): number {
  if (costsUsd.length === 0) {
    throw new RangeError("meanCost: costsUsd must be non-empty — there is no mean of zero real calls");
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
 * Every Haiku extraction attempt counts (one per label, `totalCount`);
 * every Sonnet call ATTEMPT counts (`sonnetCallCount` —
 * `batch_jobs.sonnet_call_count`, which already counts a retry the same
 * way `escalation-cap.ts`'s own doc comment requires: "first attempts and
 * retries alike").
 */
export function deriveBatchCostUsd(params: DeriveBatchCostParams): number {
  const { haikuCallCount, haikuMeanCostUsd, sonnetCallCount, sonnetMeanCostUsd } = params;
  return haikuCallCount * haikuMeanCostUsd + sonnetCallCount * sonnetMeanCostUsd;
}
