/**
 * Percentile math for the latency harness (TRO-471 / LH-031, TH-R2, PRD
 * §3.8, §6). Pure functions only — no clock, no network, no I/O — so they
 * are cheap to unit test with synthetic timings (`percentile.test.ts`) and
 * safe to run inside the gate's normal `pnpm test`, unlike `measure.ts`,
 * which spends real money and is never part of that suite.
 *
 * Percentile method: nearest-rank. Sort ascending, then
 * `rank = ceil(p / 100 * n)`, 1-indexed, clamped to `[1, n]`. This is the
 * standard definition most latency-reporting tools use (no interpolation
 * between two samples), and it is easy to defend in a hearing: "the p95 is
 * a real observed sample, not an average of two."
 */

/** count/min/max/mean/p50/p95 for one batch of millisecond durations. */
export interface LatencySummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  /** Rounded to the nearest millisecond for a readable report. */
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
}

/**
 * Returns the `p`-th percentile of `valuesMs` by the nearest-rank method.
 * Does not mutate `valuesMs`. Throws `RangeError` on an empty array or a
 * `p` outside `[0, 100]` — standing rule 12 (uncertain beats wrong): a
 * latency report with no data must fail loudly, never print `NaN` as if it
 * were a measurement.
 */
export function percentile(valuesMs: readonly number[], p: number): number {
  if (valuesMs.length === 0) {
    throw new RangeError("percentile: valuesMs is empty — no samples to summarize");
  }
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile: p must be between 0 and 100, got ${p}`);
  }
  const badIndex = valuesMs.findIndex((v) => !Number.isFinite(v));
  if (badIndex !== -1) {
    // `NaN` sorts unpredictably (the comparator's `a - b` is itself `NaN`,
    // which `Array.prototype.sort` treats as "equal" — it does not settle
    // to either end), so a NaN entry can silently corrupt which value ends
    // up at the percentile's rank. `Infinity` sorts fine but would make
    // `JSON.stringify` write `null` for it in the committed report (a
    // finite-looking budget field silently turned into no value at all).
    // Reject both instead of trusting every element is a real duration.
    throw new RangeError(
      `percentile: valuesMs must contain only finite numbers — index ${badIndex} is ${valuesMs[badIndex]}`,
    );
  }
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
}

/**
 * Summarizes one batch of millisecond durations: sample count, min, max,
 * mean (rounded to the nearest ms), p50, and p95. Throws `RangeError` on an
 * empty array or a non-finite entry — the same "never fabricate a number"
 * discipline as the rest of this ticket. Validated up front, before `min`/
 * `max`/`mean` are computed — `percentile`'s own p50/p95 calls below would
 * eventually catch a bad entry too, but only after `Math.min`/`Math.max`/
 * `reduce` had already silently produced a `NaN` mean from it. Fail fast
 * instead of fail eventually.
 */
export function summarizeLatencies(valuesMs: readonly number[]): LatencySummary {
  if (valuesMs.length === 0) {
    throw new RangeError("summarizeLatencies: valuesMs is empty — no samples to summarize");
  }
  const badIndex = valuesMs.findIndex((v) => !Number.isFinite(v));
  if (badIndex !== -1) {
    throw new RangeError(
      `summarizeLatencies: valuesMs must contain only finite numbers — index ${badIndex} is ${valuesMs[badIndex]}`,
    );
  }
  const sum = valuesMs.reduce((total, v) => total + v, 0);
  return {
    count: valuesMs.length,
    min: Math.min(...valuesMs),
    max: Math.max(...valuesMs),
    mean: Math.round(sum / valuesMs.length),
    p50: percentile(valuesMs, 50),
    p95: percentile(valuesMs, 95),
  };
}
