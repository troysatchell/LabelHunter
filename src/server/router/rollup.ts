/**
 * Rolling per-field verdicts up to one label verdict (CP-1 §5.4).
 *
 * `labelLevelBlocker` (`LOW_IMAGE_QUALITY` or `CONFLICTING_EXTRACTION`) is
 * checked FIRST, before any field verdict — a rollup that only inspects
 * field verdicts can miss a label the router itself already flagged as
 * unreadable or self-inconsistent, and wrongly return PASS. REVIEW
 * outranks FAIL, and a label-level blocker outranks both: a FAIL is a claim
 * the agency acts on, and the router does not make that claim while any
 * part of the reading is unresolved (TH-R10).
 */
import type { FieldVerdict, LabelVerdict } from "./types";

export function rollupLabelVerdict(labelLevelBlocker: boolean, fieldVerdicts: readonly FieldVerdict[]): LabelVerdict {
  if (labelLevelBlocker) return "REVIEW";
  if (fieldVerdicts.includes("NEEDS_REVIEW")) return "REVIEW";
  if (fieldVerdicts.includes("MISMATCH")) return "FAIL";
  return "PASS";
}
