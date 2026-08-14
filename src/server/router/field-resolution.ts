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
import { abvAsPercent, parseAbv, type ParsedAbv } from "../comparators/abv";
import {
  convertNetContentsToMl,
  normalizeNetContentsUnit,
  parseNetContents,
  type ParsedNetContents,
} from "../comparators/net-contents";
import type { ExtractedField } from "../extractor/types";
// `BoldSignal` only — a type-only import, so this stays the same
// dependency direction `../warning/index.ts` already documents (that
// module imports `WarningComparatorResult` from `./types`, type-only, the
// other way). `bold-detect.ts` itself imports nothing from `./router`, so
// this creates no cycle.
import type { BoldSignal } from "../warning/bold-detect";
import { MISMATCH_ESCALATION_CEILING, shouldEscalateField } from "./confidence";
import type {
  ApplicationRecord,
  ComparatorFieldKey,
  ComparatorResult,
  FieldVerdict,
  ReviewReason,
  WarningComparatorResult,
} from "./types";

/**
 * TRO-569 / INT-005: the exact reason text a reviewer sees when a
 * `not-bold` signal degrades an otherwise-MATCH warning. Names the exact
 * check (standing rule 26) — not a generic "needs a closer look". A
 * `const` (not inline) so `resolveGovernmentWarningField` and its test
 * assert the identical string.
 */
export const WARNING_NOT_BOLD_REASON =
  "'GOVERNMENT WARNING' must print in bold type; the measured prefix is not bold.";

/**
 * `tolerance[beverageType]` for the label-vs-application ABV check (CP-1
 * §5.3). Verified, not merely "fails safe": zero is the CORRECT value here,
 * for every beverage type, not a strictest-guess placeholder.
 *
 * TTB does publish ABV tolerances — 27 CFR 5.65(b) allows spirits actual
 * content to differ from the LABEL's own printed statement by up to 0.3
 * percentage points; 27 CFR 4.36(b) allows wine a similar 1-3 percentage
 * point band depending on range. But that tolerance governs how far the
 * BOTTLED PRODUCT may deviate from what its OWN LABEL prints — a product-QC
 * question. This check asks something else: does the LABEL's printed number
 * match what the APPLICANT TYPED on the application form. A correctly
 * filed application restates the label's own number exactly; the QC
 * tolerance has no bearing on a data-entry consistency check between two
 * paper records. Zero tolerance is the verified answer, not a placeholder
 * pending it (CP-1 §5.3's original VERIFY marking is closed by this note).
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

/** A tiny float-rounding allowance for "the same number, restated" — not a
 * labeling tolerance (that is `ABV_TOLERANCE_BY_BEVERAGE_TYPE`, a distinct,
 * regulatory concept). "45%" and "45.0%" parse to the identical number 45;
 * this only absorbs parser float slop, not a real second reading. */
const SAME_VALUE_EPSILON = 0.05;

/**
 * True when at least one alternate reading genuinely disagrees with the
 * primary parsed value — CP-1 §5.3 says "states the alcohol content twice,
 * in CONFLICTING ways" (emphasis CP-1's own), not "restates it at all". A
 * label reading `"45%"` with an alternate of `"45.0%"` is the same number
 * twice, not a conflict; a naive `alternates.length > 0` check would flag
 * it anyway. `abvAsPercent` (27 CFR 5.1: proof is twice the percent) is the
 * canonical scale both readings convert to before comparing.
 */
function abvAlternatesConflict(parsed: ParsedAbv, alternates: readonly string[]): boolean {
  const parsedPercent = abvAsPercent(parsed);
  return alternates.some((alternate) => {
    const alternateParsed = parseAbv(alternate);
    if (alternateParsed.percent === null && alternateParsed.proof === null) return true; // an unparsed "second reading" is still a conflict
    const alternatePercent = abvAsPercent(alternateParsed);
    // Either side unparseable-to-percent (shouldn't happen given the guard
    // above, but stay conservative rather than divide by a missing value).
    if (parsedPercent === null || alternatePercent === null) return true;
    // "45%" vs "90 Proof" is the same value on the canonical scale — not a
    // conflict. "45%" vs "100 Proof" (50%) genuinely disagrees.
    return Math.abs(parsedPercent - alternatePercent) > SAME_VALUE_EPSILON;
  });
}

/** Same reasoning as `abvAlternatesConflict`, for net contents: converts
 * both readings to mL before comparing, so `"750 mL"` restated as `"0.75 L"`
 * is not treated as a conflicting second reading either. */
function netContentsAlternatesConflict(parsed: ParsedNetContents, alternates: readonly string[]): boolean {
  const parsedMl = convertNetContentsToMl(parsed);
  return alternates.some((alternate) => {
    const alternateParsed = parseNetContents(alternate);
    if (!alternateParsed) return true;
    const alternateMl = convertNetContentsToMl(alternateParsed);
    // Equal readings never conflict, checked before the fraction — dividing
    // by `parsedMl` when it is 0 is defined as Infinity below so a REAL
    // second reading is never silently accepted, but that same Infinity
    // would otherwise also fire when the alternate states the identical
    // zero quantity, where the two readings agree exactly (PR #8 review;
    // same bug class already fixed in `../comparators/net-contents.ts`'s
    // `compareNetContents`).
    const fractionDiff =
      parsedMl === alternateMl ? 0 : parsedMl === 0 ? Infinity : Math.abs(parsedMl - alternateMl) / parsedMl;
    return fractionDiff > NET_CONTENTS_TOLERANCE_FRACTION;
  });
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

  const parsed = parseAbv(extracted.value);
  if (parsed.percent === null && parsed.proof === null) return { hit: true };
  if (abvAlternatesConflict(parsed, extracted.alternates)) return { hit: true };

  if (parsed.percent !== null && parsed.proof !== null) {
    // US convention: proof is nominally twice the percent. CP-1 §5.3's own
    // named example is "45% Alc./Vol. (100 Proof)" — 100 is not 2*45.
    if (Math.abs(parsed.proof - 2 * parsed.percent) > 0.1) return { hit: true };
  }

  // `abvAsPercent`, not `parsed.percent` directly — a proof-only label
  // (e.g. "80 Proof", no "%" stated) has `parsed.percent === null` even
  // though it states a perfectly comparable value once converted (27 CFR
  // 5.1). Gating on `parsed.percent !== null` alone silently skipped this
  // whole check for a proof-only reading (CodeRabbit finding).
  const labelPercent = abvAsPercent(parsed);
  if (labelPercent !== null && applicationAbvPercent !== undefined) {
    const exceedsTolerance = Math.abs(labelPercent - applicationAbvPercent) > tolerance;
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

  const parsed = parseNetContents(extracted.value);
  // CP-1 lists "does not parse into a number plus a unit" and "the unit is
  // not in the accepted set" as two bullets; this grammar conflates them
  // (both return `null`) — the distinction does not change the outcome
  // (either way, `AMBIGUOUS_NET_CONTENTS` fires), so one check answers both.
  if (!parsed) return { hit: true };
  if (netContentsAlternatesConflict(parsed, extracted.alternates)) return { hit: true };

  const applicationUnit = normalizeNetContentsUnit(application.netContentsUnit);
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
  /**
   * LH-025's pixel-measured bold advisory signal (TRO-532/TRO-533), for
   * the SAME image region `warningResult` was compared against. `null`
   * when no crop was ever produced (region detection found nothing) — the
   * caller nulls this the same way it nulls `warningResult` above.
   * Optional so every pre-TRO-569 call site keeps compiling unchanged; an
   * omitted value behaves exactly like `null` (this function only acts on
   * `"not-bold"` — see the TRO-569 rule below).
   */
  boldSignal?: BoldSignal | null;
}

/**
 * Resolves `government_warning`'s verdict and `ReviewReason`. The warning
 * has no `FieldComparator` of its own — CP-1 §5.3 `WARNING_MISMATCH` is a
 * contract this ticket routes on, not logic this ticket builds (that is
 * LH-020, gated by CP-2, not yet cleared).
 *
 * **TRO-569 / INT-005: the bold-signal degrade rule.** Jenny Park's
 * requirement: the GOVERNMENT WARNING prefix "has to be in all caps and
 * bold" (source-TH.md:33). Before this ticket, `boldSignal` was measured
 * and persisted but never reached this function — a non-bold prefix
 * passed silently. That silent PASS widened the requirement into
 * something weaker than the brief, which INT-005 forbids. The fix touches
 * exactly one edge: when the comparator already reached `MATCH` AND the
 * same image's bold signal reads `"not-bold"`, this function degrades the
 * field to `NEEDS_REVIEW` with a reason naming the exact check (standing
 * rule 26). `"uncertain"`, `"bold"`, and a missing signal leave a MATCH
 * untouched — never accuse on uncertainty (standing rule 12). A
 * `"not-bold"` signal never touches an existing MISMATCH or NEEDS_REVIEW,
 * and never produces a hard FAIL by itself — `bold-detect.ts`'s own
 * boundary comment still holds for that half of the old rule.
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

  // Checked on `result` (a stable local), not a destructured `verdict`, so
  // TypeScript narrows the discriminated union itself in each branch.
  const result = input.warningResult;
  if (result.verdict !== "NEEDS_REVIEW") {
    if (result.verdict === "MATCH" && input.boldSignal === "not-bold") {
      return { verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH", comparatorNote: WARNING_NOT_BOLD_REASON };
    }
    return { verdict: result.verdict, reviewReason: null, comparatorNote: result.note };
  }
  // `reviewReason` is required on this branch of `WarningComparatorResult` —
  // no default to fall back to, and none needed.
  return { verdict: "NEEDS_REVIEW", reviewReason: result.reviewReason, comparatorNote: result.note };
}
