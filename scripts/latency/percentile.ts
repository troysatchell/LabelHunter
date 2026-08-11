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
 * Validates that every entry in `valuesMs` is a real, plausible millisecond
 * duration: a finite number, zero or greater. Shared by `percentile` and
 * `summarizeLatencies` so the two functions cannot drift on what counts as
 * "a bad entry." `NaN` sorts unpredictably (`Array.prototype.sort`'s own
 * comparator returns `NaN` for a `NaN` operand, and the spec treats that as
 * "equal" — the entry never settles to either end). `Infinity` sorts fine
 * but `JSON.stringify` writes it as `null` in the committed report (a
 * finite-looking field silently turned into no value at all). A negative
 * number is not a real duration — `performance.now()` is monotonic within
 * one process, so a caller with one should never legitimately produce a
 * negative elapsed time. Throws `RangeError`, named after `caller`, rather
 * than trusting every element is a real duration.
 */
function assertValidDurations(valuesMs: readonly number[], caller: string): void {
  const badIndex = valuesMs.findIndex((v) => !Number.isFinite(v) || v < 0);
  if (badIndex !== -1) {
    const bad = valuesMs[badIndex];
    const reason = !Number.isFinite(bad) ? "finite numbers" : "non-negative numbers (a negative duration)";
    throw new RangeError(`${caller}: valuesMs must contain only ${reason} — index ${badIndex} is ${bad}`);
  }
}

/**
 * Returns the `p`-th percentile of `valuesMs` by the nearest-rank method.
 * Does not mutate `valuesMs`. Throws `RangeError` on an empty array, a `p`
 * outside `[0, 100]`, or an entry `assertValidDurations` rejects — standing
 * rule 12 (uncertain beats wrong): a latency report with no data, or bad
 * data, must fail loudly, never print `NaN` as if it were a measurement.
 */
export function percentile(valuesMs: readonly number[], p: number): number {
  if (valuesMs.length === 0) {
    throw new RangeError("percentile: valuesMs is empty — no samples to summarize");
  }
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile: p must be between 0 and 100, got ${p}`);
  }
  assertValidDurations(valuesMs, "percentile");
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
}

/**
 * Summarizes one batch of millisecond durations: sample count, min, max,
 * mean (rounded to the nearest ms), p50, and p95. Throws `RangeError` on an
 * empty array or an entry `assertValidDurations` rejects — the same "never
 * fabricate a number" discipline as the rest of this ticket. Validated up
 * front, before `min`/`max`/`mean` are computed — `percentile`'s own p50/p95
 * calls below would eventually catch a bad entry too, but only after
 * `Math.min`/`Math.max`/`reduce` had already silently produced a bad mean
 * from it. Fail fast instead of fail eventually.
 */
export function summarizeLatencies(valuesMs: readonly number[]): LatencySummary {
  if (valuesMs.length === 0) {
    throw new RangeError("summarizeLatencies: valuesMs is empty — no samples to summarize");
  }
  assertValidDurations(valuesMs, "summarizeLatencies");
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
