/**
 * The Validation Router (LH-012 / TRO-462, PRD §3.3, CP-1 §4-§5).
 *
 * `routeLabel` is the whole module's entry point: deterministic TypeScript,
 * no model call, no I/O (TH-R19 — the cascade is the architecture, not an
 * optimization; Sonnet only ever sees an escalation this function routed to
 * it). It takes the Haiku extractor's output, an application record, and
 * the caller's field comparators, and returns one row per field plus a
 * label verdict, exactly as CP-1 §5.5 specifies.
 *
 * What this ticket does NOT build: the real field comparators (LH-013,
 * `types.ts`'s `FieldComparator`) and the government-warning comparator
 * (LH-020, its own CP-2-gated subsystem, `types.ts`'s `WarningComparatorResult`).
 * Both are accepted here as contracts, not implemented here.
 */
import { BEVERAGE_TYPES } from "../../lib/db/enums";
import type { ExtractedField, HaikuExtractionResult } from "../extractor/types";
import { isValidConfidence, TRUSTED_THRESHOLD_DEFAULT } from "./confidence";
import type { FieldState } from "./field-state";
import { isFieldAbsent } from "./field-state";
import {
  ABV_TOLERANCE_BY_BEVERAGE_TYPE,
  checkAbvStructural,
  checkNetContentsStructural,
  resolveComparatorField,
  resolveGovernmentWarningField,
} from "./field-resolution";
import { isConflictingExtraction, isLowImageQuality, warningPresentTranscriptionDisagree } from "./label-blockers";
// Type-only — see field-resolution.ts's own comment on this same import
// for why it creates no cycle with `../warning`.
import type { BoldSignal } from "../warning/bold-detect";
import {
  applyFieldOverrides,
  applyGovernmentWarningOverrides,
  type FieldOverrideOutcome,
  type GovernmentWarningOverrideOutcome,
} from "./overrides";
import { pickHeadlineReason } from "./precedence";
import { type FieldRequirement, isFieldRequired, REQUIRED_FIELD_TABLE } from "./required-fields";
import { buildFieldReasonText } from "./reason-text";
import { rollupLabelVerdict } from "./rollup";
import { normalizeForBoundaryMatch } from "./text-boundary";
import type {
  ApplicationRecord,
  ComparatorFieldKey,
  FieldComparators,
  FieldResultRow,
  LabelRouterResult,
  ReviewReason,
  RouterFieldKey,
  PreprocessingSignal,
  WarningComparatorResult,
} from "./types";

const COMPARATOR_FIELD_KEYS: readonly ComparatorFieldKey[] = ["brand_name", "class_type", "alcohol_content", "net_contents"];

function toFieldState(field: RouterFieldKey, requirement: FieldRequirement, override: FieldOverrideOutcome): FieldState {
  return {
    field,
    requirement,
    required: isFieldRequired(requirement),
    value: override.value,
    present: null,
    evidence: override.evidence,
    confidence: override.confidence,
    overrideRejected: override.rejected,
  };
}

function toWarningFieldState(requirement: FieldRequirement, override: GovernmentWarningOverrideOutcome): FieldState {
  return {
    field: "government_warning",
    requirement,
    required: isFieldRequired(requirement),
    value: null,
    present: override.present,
    evidence: override.evidence,
    confidence: override.confidence,
    overrideRejected: override.rejected,
  };
}

/** `net_contents`' application value has no single natural type — the
 * application form supplies a value and a unit separately. Formatting it
 * as text (e.g. `"750 mL"`) keeps `FieldComparator`'s signature uniform:
 * both sides of a net-contents comparison are the same kind of string,
 * parsed by the same grammar (LH-013's job). */
function comparatorApplicationValue(field: ComparatorFieldKey, application: ApplicationRecord): string | number | undefined {
  switch (field) {
    case "brand_name":
      return application.brandName;
    case "class_type":
      return application.classType;
    case "alcohol_content":
      return application.alcoholContentPercent;
    case "net_contents":
      return `${application.netContentsValue} ${application.netContentsUnit}`;
  }
}

function computeStructuralHit(
  field: ComparatorFieldKey,
  extracted: ExtractedField,
  application: ApplicationRecord,
  confidence: number,
): boolean {
  switch (field) {
    case "alcohol_content":
      return checkAbvStructural(
        extracted,
        confidence,
        application.alcoholContentPercent,
        ABV_TOLERANCE_BY_BEVERAGE_TYPE[application.beverageType],
      ).hit;
    case "net_contents":
      return checkNetContentsStructural(extracted, confidence, application).hit;
    case "brand_name":
    case "class_type":
      // AMBIGUOUS_BRAND has no router-side structural check beyond the
      // comparator's own similarity verdict (CP-1 §5.3) — the generic
      // asymmetry rule (confidence.ts) already covers escalation for it.
      return false;
  }
}

/**
 * True when `normalizedValue` names one of the three beverage types the
 * application form itself can declare (LH-029 / TRO-534, CP-1 §5.3's free
 * cross-check). The extractor's schema leaves `beverage_type` free-form —
 * no enum (`extractor/schema.ts`) — so it can read an off-menu subtype the
 * application's closed `BEVERAGE_TYPES` enum has no slot for. "Mead" is
 * the case that proved it: the label prints "Mead", the application
 * declares "wine", and TTB classes mead as a wine. Neither record is
 * wrong. An off-menu answer is no opinion on the application's declared
 * type — never a conflict — so the cross-check below only fires when the
 * extractor named an actual member of the vocabulary and that member
 * disagrees.
 */
function isKnownBeverageType(normalizedValue: string): boolean {
  return (BEVERAGE_TYPES as readonly string[]).includes(normalizedValue);
}

export function routeLabel(
  extraction: HaikuExtractionResult,
  application: ApplicationRecord,
  comparators: FieldComparators,
  warningResult: WarningComparatorResult | null,
  preprocessing: PreprocessingSignal,
  /**
   * LH-025's pixel-measured bold advisory signal (TRO-532/TRO-533), for
   * the SAME image `warningResult` was compared against — `../warning`'s
   * `compareGovernmentWarningFromImage` returns it as a sibling field,
   * never folded into `warningResult` itself (that module's own header
   * comment). Optional, default `null`, so every pre-TRO-569 call site
   * (this router's own test files, `src/server/comparators/index.test.ts`)
   * keeps compiling and behaving unchanged. TRO-569 / INT-005:
   * `resolveGovernmentWarningField` (`field-resolution.ts`) degrades an
   * otherwise-MATCH warning to NEEDS_REVIEW when this reads `"not-bold"` —
   * the only edge this parameter touches.
   */
  warningBoldSignal: BoldSignal | null = null,
): LabelRouterResult {
  const requiredTable = REQUIRED_FIELD_TABLE[application.beverageType];

  // --- CP-1 §4.4: the deterministic overrides, once per field ------------
  const brandOverride = applyFieldOverrides(extraction.brand_name, "text");
  const classOverride = applyFieldOverrides(extraction.class_type, "text");
  const abvOverride = applyFieldOverrides(extraction.alcohol_content, "numeric_abv");
  const netOverride = applyFieldOverrides(extraction.net_contents, "numeric_net_contents");
  // TRO-502 (a known open issue, already ticketed, cited in CP-1's approved
  // design): beverage_type's value is an inferred category (e.g. "spirits"),
  // never verbatim in the label's evidence (e.g. "Bourbon Whiskey"). Rule 2
  // (evidence supports value, §4.4) cannot be satisfied literally for this
  // one field. This is a deliberate, documented exemption — beverage_type
  // still gets rules 1 (evidence present) and 3 (confidence valid).
  const beverageTypeOverride = applyFieldOverrides(extraction.beverage_type, "exempt");
  const warningOverride = applyGovernmentWarningOverrides(extraction.government_warning);

  const fieldStates: Record<RouterFieldKey, FieldState> = {
    brand_name: toFieldState("brand_name", requiredTable.brand_name, brandOverride),
    class_type: toFieldState("class_type", requiredTable.class_type, classOverride),
    alcohol_content: toFieldState("alcohol_content", requiredTable.alcohol_content, abvOverride),
    net_contents: toFieldState("net_contents", requiredTable.net_contents, netOverride),
    government_warning: toWarningFieldState(requiredTable.government_warning, warningOverride),
  };

  const requiredFieldStates = Object.values(fieldStates).filter((state) => state.required);

  // --- CP-1 §5.3: the two label-level blockers ----------------------------
  // TRO-542: `isLowImageQuality` now names WHICH rule fired, not just
  // whether one did. `lowImageQuality` stays a plain boolean below — every
  // existing rollup/precedence computation reads it unchanged.
  const lowImageQualityTrigger = isLowImageQuality(extraction.image_quality, preprocessing, requiredFieldStates);
  const lowImageQuality = lowImageQualityTrigger !== null;

  // `beverage_type.value` is a free-form string in the extractor's JSON
  // schema (`schema.ts`'s "field" $def), not an enum the schema itself
  // constrains — a casing or whitespace slip ("Spirits" vs "spirits") is
  // untrusted extractor output, not a real disagreement, so both sides are
  // normalized the same way as the evidence word-boundary check before
  // comparing. `TRUSTED_THRESHOLD_DEFAULT` (not a separate 0.85 literal):
  // CP-1 §5.3's own number for this rule is the Trusted-band floor — the
  // same "confident enough to act on" question the band answers elsewhere.
  //
  // A vocabulary guard gates the comparison (LH-029 / TRO-534): the
  // extractor's free-form field can also read an off-menu subtype
  // (`isKnownBeverageType`'s own comment has the full "mead" story). Only
  // a normalized value that is itself a real `BEVERAGE_TYPES` member can
  // disagree with the application — an off-menu answer is no opinion, not
  // a conflict, and must not block the label.
  const normalizedBeverageTypeValue =
    extraction.beverage_type.value !== null ? normalizeForBoundaryMatch(extraction.beverage_type.value) : null;
  const beverageTypeDisagreesWithApplication =
    normalizedBeverageTypeValue !== null &&
    isKnownBeverageType(normalizedBeverageTypeValue) &&
    normalizedBeverageTypeValue !== normalizeForBoundaryMatch(application.beverageType) &&
    extraction.beverage_type.confidence >= TRUSTED_THRESHOLD_DEFAULT;

  const conflictingExtraction = isConflictingExtraction({
    fieldOverrideRejections: [
      brandOverride.rejected,
      classOverride.rejected,
      abvOverride.rejected,
      netOverride.rejected,
      beverageTypeOverride.rejected,
      warningOverride.rejected,
    ],
    imageQualityConfidenceInvalid: !isValidConfidence(extraction.image_quality.confidence),
    warningPresentTranscriptionDisagree: warningPresentTranscriptionDisagree(
      extraction.government_warning.present,
      extraction.government_warning.transcription,
    ),
    beverageTypeDisagreesWithApplication,
  });

  const labelLevelBlocker = lowImageQuality || conflictingExtraction;

  const reasonsPresent = new Set<ReviewReason>();
  if (lowImageQuality) reasonsPresent.add("LOW_IMAGE_QUALITY");
  if (conflictingExtraction) reasonsPresent.add("CONFLICTING_EXTRACTION");

  // --- The four comparator-driven fields ----------------------------------
  const rows: FieldResultRow[] = [];

  for (const field of COMPARATOR_FIELD_KEYS) {
    const state = fieldStates[field];
    const extracted = extraction[field];
    const applicationValue = comparatorApplicationValue(field, application);
    const absent = isFieldAbsent(state);

    const comparatorResult =
      state.overrideRejected || absent || applicationValue === undefined
        ? null
        : comparators[field](extracted, applicationValue, { beverageType: application.beverageType });

    const structuralHit = computeStructuralHit(field, extracted, application, state.confidence);

    const resolution = resolveComparatorField({
      field,
      required: state.required,
      overrideRejected: state.overrideRejected,
      absent,
      lowImageQuality,
      comparatorResult,
      confidence: state.confidence,
      structuralHit,
    });

    if (resolution.reviewReason) reasonsPresent.add(resolution.reviewReason);

    rows.push({
      field,
      verdict: resolution.verdict,
      labelValue: state.value,
      applicationValue: applicationValue ?? "(not filed on the application)",
      evidence: state.evidence,
      confidence: state.confidence,
      reason: buildFieldReasonText(resolution.verdict, resolution.reviewReason, resolution.comparatorNote),
      reviewReason: resolution.reviewReason,
      resolvedBy: null,
    });
  }

  // --- The government warning: contract only (LH-020, gated by CP-2) -----
  const warningState = fieldStates.government_warning;
  const warningAbsent = isFieldAbsent(warningState);
  const warningResolution = resolveGovernmentWarningField({
    required: warningState.required,
    overrideRejected: warningState.overrideRejected,
    absent: warningAbsent,
    lowImageQuality,
    warningResult: warningState.overrideRejected || warningAbsent ? null : warningResult,
    // TRO-569 — nulled the same way `warningResult` is above: the degrade
    // rule only ever matters once a real comparator result exists to
    // degrade.
    boldSignal: warningState.overrideRejected || warningAbsent ? null : warningBoldSignal,
  });
  if (warningResolution.reviewReason) reasonsPresent.add(warningResolution.reviewReason);

  rows.push({
    field: "government_warning",
    verdict: warningResolution.verdict,
    labelValue: warningOverride.transcription,
    applicationValue: "the statutory warning text (27 CFR part 16)",
    evidence: warningState.evidence,
    confidence: warningState.confidence,
    reason: buildFieldReasonText(warningResolution.verdict, warningResolution.reviewReason, warningResolution.comparatorNote),
    reviewReason: warningResolution.reviewReason,
    resolvedBy: null,
  });

  const labelVerdict = rollupLabelVerdict(
    labelLevelBlocker,
    rows.map((row) => row.verdict),
  );
  const headlineReason = pickHeadlineReason(reasonsPresent);

  return {
    labelVerdict,
    headlineReason,
    fields: rows,
    lowImageQualityTrigger,
    // TRO-542 step 4: the router reads `image_quality.issues` here — carried
    // through verbatim, evidence only, never a decision input (see
    // `LabelRouterResult.imageQualityIssues`'s own doc comment). Copied, not
    // the original array reference — `routeLabel` is documented pure, and a
    // caller must not be able to mutate the input `extraction` and silently
    // change an already-returned result (CodeRabbit finding).
    imageQualityIssues: [...extraction.image_quality.issues],
  };
}

export type {
  ApplicationRecord,
  ComparatorContext,
  ComparatorFieldKey,
  ComparatorResult,
  FieldComparator,
  FieldComparators,
  FieldResultRow,
  FieldVerdict,
  LabelRouterResult,
  LabelVerdict,
  LowImageQualityTrigger,
  PreprocessingSignal,
  ReviewReason,
  RouterFieldKey,
  WarningComparatorChannel,
  WarningComparatorResult,
} from "./types";
export { getTrustedThreshold, classifyConfidenceBand, shouldEscalateField } from "./confidence";
export { REQUIRED_FIELD_TABLE, isFieldRequired } from "./required-fields";
export { REVIEW_REASON_PRECEDENCE, pickHeadlineReason } from "./precedence";
export { rollupLabelVerdict } from "./rollup";
