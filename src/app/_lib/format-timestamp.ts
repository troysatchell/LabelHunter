/**
 * One timestamp format for the review queue's list and detail views
 * (TRO-476, PRD §5) — an absolute UTC time, not a relative one ("3 minutes
 * ago"). Two reasons: a relative string keeps changing, which makes a
 * screenshot or a live defense show a different answer than the one just
 * discussed a moment earlier; and this is a compliance record, where an
 * exact, fixed timestamp reads as more trustworthy than a casual one.
 *
 * Explicit `timeZone: "UTC"` — not the machine's own zone — is what makes
 * this deterministic in CI and in tests: the same instant must format to
 * the same string regardless of which timezone the process happens to run
 * in.
 */
const FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatTimestampUTC(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${FORMATTER.format(date)} UTC`;
}
