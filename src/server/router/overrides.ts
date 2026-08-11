/**
 * The deterministic anti-hallucination overrides (CP-1 §4.4). These run
 * BEFORE any confidence threshold and ignore confidence entirely except to
 * check that it is a real number. Each one can reject a field outright —
 * force it to `value: null` (or, for the government warning,
 * `present: null, transcription: null`) — regardless of how confident the
 * extractor claims to be. This is the check that catches a confident
 * invention, which a threshold alone cannot catch.
 *
 * This module validates the extractor's output at the boundary where the
 * router receives it. `HaikuExtractionResult` is untrusted input here — the
 * extractor's own tests (LH-011) check its output is well-SHAPED; they do
 * not check it is well-EVIDENCED. That is this ticket's job.
 */
import { abvAsPercent, parseAbv, type ParsedAbv } from "../comparators/abv";
import { convertNetContentsToMl, parseNetContents, type ParsedNetContents } from "../comparators/net-contents";
import type { ExtractedField, ExtractedGovernmentWarning } from "../extractor/types";
import { isValidConfidence } from "./confidence";
import { evidenceSupportsTextValue } from "./text-boundary";

/** Which §4.4 check rejected a field, or `null` when none did. Kept for the
 * audit trail and for tests — not a `ReviewReason` itself, since every
 * rejection here routes to the same reason, `CONFLICTING_EXTRACTION`. */
export type OverrideViolation = "evidence_missing" | "evidence_does_not_support_value" | "confidence_invalid" | null;

/**
 * How the §4.4 rule 2 evidence check reads a field's `value`. `"exempt"`
 * skips rule 2 entirely — used only for `beverage_type`, see the TRO-502
 * comment at its call site in `index.ts`. `"text"` is the word-boundary
 * check (`text-boundary.ts`); `"numeric_abv"` / `"numeric_net_contents"` use
 * the real numeric grammar (`../comparators/abv.ts`, `../comparators/net-
 * contents.ts`), each falling back to the word-boundary check when the
 * value itself does not parse — a parse failure is `AMBIGUOUS_ABV` /
 * `AMBIGUOUS_NET_CONTENTS`'s job to flag (`field-resolution.ts`), not this
 * override's.
 */
export type EvidenceSupportKind = "text" | "numeric_abv" | "numeric_net_contents" | "exempt";

/** One field's state after the §4.4 overrides run. */
export interface FieldOverrideOutcome {
  rejected: boolean;
  violation: OverrideViolation;
  /** `null` when rejected; the extractor's original value otherwise. */
  value: string | null;
  /** Verbatim, unchanged — kept even when rejected, for the audit trail. */
  evidence: string;
  /** 0 when the rejection cause is an invalid confidence number (a NaN or
   * out-of-range number cannot be shown); the extractor's original
   * confidence otherwise, even when a different rule rejected the field —
   * a reviewer benefits from seeing what the model claimed, even when the
   * router did not trust it. */
  confidence: number;
}

function numbersClose(a: number, b: number | null, epsilon = 0.01): boolean {
  return b !== null && Math.abs(a - b) <= epsilon;
}

/**
 * `abvAsPercent`, not a per-axis (percent-vs-percent, proof-vs-proof)
 * comparison. The value and the evidence do not have to state the SAME
 * axis to agree — "45%" (value) and "90 Proof" (evidence) are the same
 * reading on the canonical percent scale (27 CFR 5.1). A per-axis-only
 * comparison (CodeRabbit finding; the same bug class TRO-462's own
 * `abvAlternatesConflict` fixed for the alternates check) would compare
 * `evidenceParsed.percent` — `null`, since the evidence states only proof —
 * against the value's percent, and reject a genuinely well-evidenced
 * reading. Catching a percent/proof SELF-contradiction within one field's
 * own value is `checkAbvStructural` and `compareAbv`'s job, not this
 * override's — this check only asks whether the evidence supports the
 * value's canonical number, not whether the model's own two axes agree.
 */
function numericEvidenceSupportsAbv(value: string, evidence: string): boolean {
  const valueParsed: ParsedAbv = parseAbv(value);
  const valuePercent = abvAsPercent(valueParsed);
  if (valuePercent === null) {
    // The value itself does not parse under the ABV grammar.
    // `AMBIGUOUS_ABV` (field-resolution.ts) flags the parse failure on its
    // own; this override only checks for a hallucinated value, so it falls
    // back to the weaker word-boundary text check.
    return evidenceSupportsTextValue(value, evidence);
  }
  const evidenceParsed = parseAbv(evidence);
  return numbersClose(valuePercent, abvAsPercent(evidenceParsed));
}

/** A small, absolute mL tolerance for comparing `value` against `evidence`
 * on the SAME field — these should be near-identical (`value` is derived
 * from `evidence`, not an independent second estimate), so this only
 * absorbs float/rounding slop, not a real disagreement. */
const NET_CONTENTS_EVIDENCE_TOLERANCE_ML = 0.5;

function numericEvidenceSupportsNetContents(value: string, evidence: string): boolean {
  const valueParsed: ParsedNetContents | null = parseNetContents(value);
  if (!valueParsed) {
    // Same fallback reasoning as the ABV case above.
    return evidenceSupportsTextValue(value, evidence);
  }
  const evidenceParsed = parseNetContents(evidence);
  if (!evidenceParsed) return false;
  // Convert both to mL before comparing — CP-1 §5.3 itself compares "the
  // CONVERTED values" for a cross-unit reading, not the raw numbers. A
  // value of "750 mL" and evidence of "0.75 L" describe the same quantity;
  // requiring the unit STRINGS to match too would reject a genuine read.
  const valueMl = convertNetContentsToMl(valueParsed);
  const evidenceMl = convertNetContentsToMl(evidenceParsed);
  return Math.abs(valueMl - evidenceMl) <= NET_CONTENTS_EVIDENCE_TOLERANCE_ML;
}

function evidenceSupportsValue(value: string, evidence: string, kind: EvidenceSupportKind): boolean {
  switch (kind) {
    case "text":
      return evidenceSupportsTextValue(value, evidence);
    case "numeric_abv":
      return numericEvidenceSupportsAbv(value, evidence);
    case "numeric_net_contents":
      return numericEvidenceSupportsNetContents(value, evidence);
    case "exempt":
      return true;
  }
}

/**
 * Applies the three §4.4 overrides to one `ExtractedField`
 * (`brand_name`, `class_type`, `alcohol_content`, `net_contents`, or
 * `beverage_type`). Order matches the doc: confidence sanity first (it
 * ignores value and evidence entirely), then evidence presence, then
 * evidence support.
 */
export function applyFieldOverrides(field: ExtractedField, supportKind: EvidenceSupportKind): FieldOverrideOutcome {
  if (!isValidConfidence(field.confidence)) {
    return { rejected: true, violation: "confidence_invalid", value: null, evidence: field.evidence, confidence: 0 };
  }
  if (field.value !== null && field.evidence.length === 0) {
    return {
      rejected: true,
      violation: "evidence_missing",
      value: null,
      evidence: field.evidence,
      confidence: field.confidence,
    };
  }
  if (field.value !== null && supportKind !== "exempt") {
    if (!evidenceSupportsValue(field.value, field.evidence, supportKind)) {
      return {
        rejected: true,
        violation: "evidence_does_not_support_value",
        value: null,
        evidence: field.evidence,
        confidence: field.confidence,
      };
    }
  }
  return { rejected: false, violation: null, value: field.value, evidence: field.evidence, confidence: field.confidence };
}

/** The government warning's state after the §4.4 overrides run. It has no
 * `value` (CP-1 §3.4) — rejection sets `present: null, transcription: null`
 * instead, per §4.4's field-shape-aware rejection payload. */
export interface GovernmentWarningOverrideOutcome {
  rejected: boolean;
  violation: OverrideViolation;
  present: boolean | null;
  transcription: string | null;
  evidence: string;
  confidence: number;
}

export function applyGovernmentWarningOverrides(
  warning: ExtractedGovernmentWarning,
): GovernmentWarningOverrideOutcome {
  if (!isValidConfidence(warning.confidence)) {
    return {
      rejected: true,
      violation: "confidence_invalid",
      present: null,
      transcription: null,
      evidence: warning.evidence,
      confidence: 0,
    };
  }
  if (warning.transcription !== null && warning.evidence.length === 0) {
    return {
      rejected: true,
      violation: "evidence_missing",
      present: null,
      transcription: null,
      evidence: warning.evidence,
      confidence: warning.confidence,
    };
  }
  if (warning.transcription !== null) {
    if (!evidenceSupportsTextValue(warning.transcription, warning.evidence)) {
      return {
        rejected: true,
        violation: "evidence_does_not_support_value",
        present: null,
        transcription: null,
        evidence: warning.evidence,
        confidence: warning.confidence,
      };
    }
  }
  return {
    rejected: false,
    violation: null,
    present: warning.present,
    transcription: warning.transcription,
    evidence: warning.evidence,
    confidence: warning.confidence,
  };
}
