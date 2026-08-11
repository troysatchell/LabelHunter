/**
 * Turns a judged resolution into a router `FieldResultRow` (LH-014 /
 * TRO-464, CP-1 §6.5, `../router/types.ts`'s `FieldResultRow`).
 *
 * This is the ONLY place this module constructs a `FieldResultRow` — and
 * only for `brand_name` / `class_type`, the two fields TH-R8 makes the
 * resolver's own judgment authoritative for. `toJudgedFieldResultRow`'s
 * parameter type is `JudgedFieldResolution`, not `ResolvedFieldResult`, so
 * calling it with a correction-field resolution (`alcohol_content`,
 * `net_contents`, `government_warning`) is a compile error, not a runtime
 * check — see `field-result.test.ts`. Those three fields still need a real
 * comparator re-run on the corrected reading before they have a final
 * verdict (CP-1 §6.5: "code re-decides"); that comparator is the router's
 * (LH-013), wired up by the pipeline (LH-015/LH-016), not this ticket.
 *
 * `resolvedBy: "sonnet"` requires a `reviewReason` (`FieldResultRow`'s
 * discriminated union, `../router/types.ts`) — the reason is threaded
 * through from the `FlaggedField` that caused this field to be sent to the
 * resolver in the first place, never invented here.
 */
import type { FieldResultRow, ReviewReason } from "../router/types";
import type { JudgedFieldResolution } from "./types";

/**
 * Maps a judged resolution to its `FieldResultRow`. `NEEDS_HUMAN` produces
 * `resolvedBy: null` — nobody has resolved this field yet; Sonnet looked and
 * could not decide, so it stays exactly where an unresolved field already
 * lives in this discriminated union (`reviewReason` set, `resolvedBy` null),
 * pending a human. Only `RESOLVED_MATCH`/`RESOLVED_MISMATCH` set
 * `resolvedBy: "sonnet"` — a model's opinion is the verdict, and the row
 * says so.
 */
export function toJudgedFieldResultRow(
  resolution: JudgedFieldResolution,
  reviewReason: ReviewReason,
  applicationValue: string,
): FieldResultRow {
  const base = {
    field: resolution.field,
    labelValue: resolution.correctedValue,
    applicationValue,
    evidence: resolution.evidence,
    confidence: resolution.confidence,
    reason: resolution.reason,
  };

  if (resolution.disposition === "NEEDS_HUMAN") {
    return { ...base, verdict: "NEEDS_REVIEW", resolvedBy: null, reviewReason };
  }

  return {
    ...base,
    verdict: resolution.disposition === "RESOLVED_MATCH" ? "MATCH" : "MISMATCH",
    resolvedBy: "sonnet",
    reviewReason,
  };
}
