/**
 * Per-field verdict and `ReviewReason` resolution for the four comparator-
 * driven fields (`brand_name`, `class_type`, `alcohol_content`,
 * `net_contents`) and, separately, the government warning.
 *
 * Two kinds of finding feed a field's escalation:
 * 1. The generic asymmetry rule (`confidence.ts`'s `shouldEscalateField`) —
 *    driven by the comparator's own verdict and the field's confidence.
 * 2. A field-specific STRUCTURAL check named in CP-1 §5.3 — a self-
 *    contradiction, an unparsed value, a second reading in `alternates` —
 *    that fires independent of confidence.
 *
 * Either one escalates the field. When it does, the field's own named
 * reason (`AMBIGUOUS_ABV`, `AMBIGUOUS_NET_CONTENTS`, or `AMBIGUOUS_BRAND`)
 * applies whenever the comparator itself found something (MISMATCH,
 * NEEDS_REVIEW, or a structural hit). `LOW_MODEL_CONFIDENCE`, the residual
 * bucket, applies only when the comparator said MATCH and confidence alone
 * forced the escalation (CP-1 §5.3: "no higher-ranked reason applied").
 */
import type { ExtractedField } from "../extractor/types";
import { MISMATCH_ESCALATION_CEILING, shouldEscalateField } from "./confidence";
import {
  convertNetContentsToMl,
  normalizeProvisionalUnit,
  provisionalParseAbv,
  provisionalParseNetContents,
} from "./provisional-numeric";
import type {
  ApplicationRecord,
  ComparatorFieldKey,
  ComparatorResult,
  FieldVerdict,
  ReviewReason,
  WarningComparatorResult,
} from "./types";

/**
 * `tolerance[beverageType]` for the ABV self-consistency check (CP-1 §5.3).
 * **VERIFY** — TTB permits labeling tolerances that differ by beverage
 * type; this document does not encode them. Zero fails safe: nothing is
 * silently accepted before the real value is verified and cited. LH-013
 * replaces this with the cited real values.
 */
export const ABV_TOLERANCE_BY_BEVERAGE_TYPE: Record<ApplicationRecord["beverageType"], number> = {
  beer: 0,
  wine: 0,
  spirits: 0,
};

/** The net-contents unit-mismatch tolerance (CP-1 §5.3, "proposed"). Not
 * beverage-type-dependent in the source document. */
export const NET_CONTENTS_TOLERANCE_FRACTION = 0.005;

export const FIELD_SPECIFIC_REASON: Record<ComparatorFieldKey, ReviewReason> = {
  brand_name: "AMBIGUOUS_BRAND",
  // Same rule as brand_name (CP-1 §5.3, end of the AMBIGUOUS_BRAND section).
  class_type: "AMBIGUOUS_BRAND",
  alcohol_content: "AMBIGUOUS_ABV",
  net_contents: "AMBIGUOUS_NET_CONTENTS",
};

export interface StructuralCheck {
  hit: boolean;
}

/**
 * The `AMBIGUOUS_ABV` structural checks (CP-1 §5.3), independent of
 * confidence: does not parse, states two conflicting readings
 * (`alternates`), or the label's own percent and proof contradict each
 * other. The fourth CP-1 bullet — the label-vs-application tolerance check
 * — needs `confidence`, since it only fires below the mismatch-escalation
 * ceiling; it is folded in here for the same reason the doc states it as
 * one `AMBIGUOUS_ABV` bullet, not a separate rule.
 */
export function checkAbvStructural(
  extracted: ExtractedField,
  confidence: number,
  applicationAbvPercent: number | undefined,
  tolerance: number,
): StructuralCheck {
  if (extracted.value === null) return { hit: false }; // MISSING_REQUIRED_FIELD's territory, not this one.

  const parsed = provisionalParseAbv(extracted.value);
  if (parsed.percent === null && parsed.proof === null) return { hit: true };
  if (extracted.alternates.length > 0) return { hit: true };

  if (parsed.percent !== null && parsed.proof !== null) {
    // US convention: proof is nominally twice the percent. CP-1 §5.3's own
    // named example is "45% Alc./Vol. (100 Proof)" — 100 is not 2*45.
    if (Math.abs(parsed.proof - 2 * parsed.percent) > 0.1) return { hit: true };
  }

  if (parsed.percent !== null && applicationAbvPercent !== undefined) {
    const exceedsTolerance = Math.abs(parsed.percent - applicationAbvPercent) > tolerance;
    if (exceedsTolerance && confidence < MISMATCH_ESCALATION_CEILING) return { hit: true };
  }

  return { hit: false };
}

/** The `AMBIGUOUS_NET_CONTENTS` structural checks (CP-1 §5.3): does not
 * parse into a number plus an accepted unit, states two conflicting
 * readings, or a unit conversion against the application disagrees by more
 * than the tolerance below the mismatch-escalation ceiling. */
export function checkNetContentsStructural(
  extracted: ExtractedField,
  confidence: number,
  application: Pick<ApplicationRecord, "netContentsValue" | "netContentsUnit">,
): StructuralCheck {
  if (extracted.value === null) return { hit: false };

  const parsed = provisionalParseNetContents(extracted.value);
  // CP-1 lists "does not parse into a number plus a unit" and "the unit is
  // not in the accepted set" as two bullets; this stand-in parser conflates
  // them (both return `null`) — a deliberate simplification LH-013 unwinds.
  if (!parsed) return { hit: true };
  if (extracted.alternates.length > 0) return { hit: true };

  const applicationUnit = normalizeProvisionalUnit(application.netContentsUnit);
  if (applicationUnit === null) return { hit: false }; // Cannot compare; do not fabricate a finding.

  if (parsed.unit !== applicationUnit) {
    const labelMl = convertNetContentsToMl(parsed);
    const applicationMl = convertNetContentsToMl({ value: application.netContentsValue, unit: applicationUnit });
    const fractionDiff = applicationMl === 0 ? Infinity : Math.abs(labelMl - applicationMl) / applicationMl;
    if (fractionDiff > NET_CONTENTS_TOLERANCE_FRACTION && confidence < MISMATCH_ESCALATION_CEILING) {
      return { hit: true };
    }
  }

  return { hit: false };
}

export interface ComparatorFieldResolutionInput {
  field: ComparatorFieldKey;
  required: boolean;
  /** True when this field's own §4.4 override rejected it. */
  overrideRejected: boolean;
  /** True when the sanitized value is absent (`FieldState`'s `isFieldAbsent`). */
  absent: boolean;
  /** True when `LOW_IMAGE_QUALITY` already fired for this label — CP-1
   * §5.3's own carve-out: `MISSING_REQUIRED_FIELD` does not also fire then. */
  lowImageQuality: boolean;
  comparatorResult: ComparatorResult | null;
  confidence: number;
  structuralHit: boolean;
}

export interface FieldResolution {
  verdict: FieldVerdict;
  reviewReason: ReviewReason | null;
  /** The comparator's own note, when it ran and returned one. */
  comparatorNote?: string;
}

/**
 * Resolves one comparator-driven field's verdict and `ReviewReason`, in
 * CP-1 §5.2 precedence order: an override rejection (`CONFLICTING_
 * EXTRACTION`) outranks absence (`MISSING_REQUIRED_FIELD`), which outranks
 * the field-specific `AMBIGUOUS_*` / `LOW_MODEL_CONFIDENCE` checks.
 */
export function resolveComparatorField(input: ComparatorFieldResolutionInput): FieldResolution {
  if (input.overrideRejected) {
    return { verdict: "NEEDS_REVIEW", reviewReason: "CONFLICTING_EXTRACTION" };
  }

  if (input.absent) {
    if (input.required && !input.lowImageQuality) {
      return { verdict: "NEEDS_REVIEW", reviewReason: "MISSING_REQUIRED_FIELD" };
    }
    // Either not required, or LOW_IMAGE_QUALITY already explains the whole
    // label (CP-1 §5.3: "and LOW_IMAGE_QUALITY did not fire").
    return { verdict: input.required ? "NEEDS_REVIEW" : "MATCH", reviewReason: null };
  }

  const comparatorVerdict = input.comparatorResult?.verdict ?? "NEEDS_REVIEW";
  const escalate = input.structuralHit || shouldEscalateField(comparatorVerdict, input.confidence);
  if (!escalate) {
    return { verdict: comparatorVerdict, reviewReason: null, comparatorNote: input.comparatorResult?.note };
  }

  const reviewReason: ReviewReason =
    input.structuralHit || comparatorVerdict !== "MATCH" ? FIELD_SPECIFIC_REASON[input.field] : "LOW_MODEL_CONFIDENCE";
  return { verdict: "NEEDS_REVIEW", reviewReason, comparatorNote: input.comparatorResult?.note };
}

export interface WarningFieldResolutionInput {
  required: boolean;
  overrideRejected: boolean;
  absent: boolean;
  lowImageQuality: boolean;
  /** The LH-020 warning comparator's result — `null` only when the field is
   * absent or override-rejected, in which case it is never consulted. */
  warningResult: WarningComparatorResult | null;
}

/**
 * Resolves `government_warning`'s verdict and `ReviewReason`. The warning
 * has no `FieldComparator` of its own — CP-1 §5.3 `WARNING_MISMATCH` is a
 * contract this ticket routes on, not logic this ticket builds (that is
 * LH-020, gated by CP-2, not yet cleared).
 */
export function resolveGovernmentWarningField(input: WarningFieldResolutionInput): FieldResolution {
  if (input.overrideRejected) {
    return { verdict: "NEEDS_REVIEW", reviewReason: "CONFLICTING_EXTRACTION" };
  }

  if (input.absent) {
    if (input.required && !input.lowImageQuality) {
      return { verdict: "NEEDS_REVIEW", reviewReason: "MISSING_REQUIRED_FIELD" };
    }
    return { verdict: input.required ? "NEEDS_REVIEW" : "MATCH", reviewReason: null };
  }

  if (!input.warningResult) {
    // Defensive: a present, un-rejected warning must carry a comparator
    // result. Route to review rather than silently pass an unresolved
    // field (TH-R10: uncertain beats wrong).
    return { verdict: "NEEDS_REVIEW", reviewReason: "LOW_MODEL_CONFIDENCE" };
  }

  const { verdict, reviewReason, note } = input.warningResult;
  if (verdict !== "NEEDS_REVIEW") {
    return { verdict, reviewReason: null, comparatorNote: note };
  }
  return { verdict: "NEEDS_REVIEW", reviewReason: reviewReason ?? "WARNING_MISMATCH", comparatorNote: note };
}
