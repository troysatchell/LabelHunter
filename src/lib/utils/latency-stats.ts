/**
 * Latency summary for the batch progress endpoint (LH-042 / TRO-475, PRD
 * §3.5/§3.8, TH-R4: "avg + p95 latency" for items processed so far).
 *
 * Same percentile method as `scripts/latency/percentile.ts`'s
 * `summarizeLatencies`: nearest-rank — sort ascending, `rank = ceil(p / 100
 * * n)`, 1-indexed, clamped to `[1, n]`. This is a small, deliberate
 * duplicate, not a shared import: `scripts/` holds developer tooling (the
 * offline latency harness, run by hand, never deployed); `src/` holds the
 * deployed app. Keeping that boundary one-directional — `src/` never
 * imports from `scripts/` — matches the layering rule
 * `src/server/review-queue/types.ts` already states for its own small,
 * intentional duplicate of `FIELD_NAME_LABELS`, rather than making this
 * ticket the first exception.
 */
export interface LatencyStats {
  readonly count: number;
  readonly avgMs: number;
  readonly p95Ms: number;
}

function percentile(sortedAscending: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank, 1), sortedAscending.length) - 1;
  return sortedAscending[index];
}

/**
 * Summarizes a batch of millisecond durations into a count, an average, and
 * a p95 — both rounded to the nearest millisecond for a readable report.
 *
 * Returns `null` for zero samples, never a fabricated `0`: a batch with no
 * finished items yet has no latency to report (standing rules 1/2 — never
 * fabricate a number; CLAUDE.md's "never fabricate a number" non-negotiable).
 * The caller shows "not measured yet", not a number that looks real.
 *
 * Throws `RangeError` on a negative or non-finite entry — a bad duration is
 * a caller bug (a clock read wrong), not a value to silently average in.
 */
export function computeLatencyStats(durationsMs: readonly number[]): LatencyStats | null {
  if (durationsMs.length === 0) return null;

  const badIndex = durationsMs.findIndex((v) => !Number.isFinite(v) || v < 0);
  if (badIndex !== -1) {
    const bad = durationsMs[badIndex];
    throw new RangeError(`computeLatencyStats: durationsMs must contain only finite, non-negative numbers — index ${badIndex} is ${bad}`);
  }

  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((total, v) => total + v, 0);
  return {
    count: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    p95Ms: percentile(sorted, 95),
  };
}
