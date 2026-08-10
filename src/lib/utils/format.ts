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

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  }

  // Round the total once before splitting into minutes/seconds — rounding
  // each part separately can carry a remainder of 60 (e.g. 119.6s produced
  // "1m 60s" instead of "2m 0s").
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainderSeconds = totalSeconds % 60;
  return `${minutes}m ${remainderSeconds}s`;
}
