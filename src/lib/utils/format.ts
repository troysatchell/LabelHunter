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

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainderSeconds}s`;
}
