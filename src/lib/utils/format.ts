/**
 * Formats a millisecond duration as a short, human-readable string, e.g.
 * `125ms`, `4.99s`, `2m 5s`. Intended for latency reporting (PRD §6 — p50/p95
 * measurements for TH-R2) and anywhere else a duration needs to render
 * compactly in the UI.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(
      `formatDuration: expected a finite, non-negative number, got ${ms}`,
    );
  }

  // Round milliseconds before picking a unit — 999.5ms rounds to 1000, and
  // formatDuration(1000) already returns seconds ("1.00s"), so an unrounded
  // check here would render the same instant two different ways.
  const roundedMs = Math.round(ms);
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }

  const seconds = roundedMs / 1000;
  if (seconds < 60) {
    const decimalPlaces = seconds < 10 ? 2 : 1;
    const rendered = Number(seconds.toFixed(decimalPlaces));
    // A value like 59.999s rounds UP to "60.0s" here, which is wrong the
    // same way "1m 60s" was wrong below — fall through to the minutes
    // format instead of displaying a 60-second reading as seconds.
    if (rendered < 60) {
      return `${rendered.toFixed(decimalPlaces)}s`;
    }
  }

  // Round the total once before splitting into minutes/seconds — rounding
  // each part separately can carry a remainder of 60 (e.g. 119.6s produced
  // "1m 60s" instead of "2m 0s").
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainderSeconds = totalSeconds % 60;
  return `${minutes}m ${remainderSeconds}s`;
}
