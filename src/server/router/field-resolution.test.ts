import { describe, expect, it } from "vitest";
import type { ExtractedField } from "../extractor/types";
import {
  checkAbvStructural,
  checkNetContentsStructural,
  resolveComparatorField,
  resolveGovernmentWarningField,
  type ComparatorFieldResolutionInput,
} from "./field-resolution";

function abvField(overrides: Partial<ExtractedField> = {}): ExtractedField {
  return { value: "45% Alc./Vol. (90 Proof)", evidence: "45% Alc./Vol. (90 Proof)", confidence: 0.9, alternates: [], ...overrides };
}

describe("checkAbvStructural — CP-1 §5.3 AMBIGUOUS_ABV, the named proof-arithmetic case", () => {
  it("a label reading '45% Alc./Vol. (100 Proof)' is internally inconsistent — CP-1's own worked example", () => {
    // 100 proof should be 90 (2 * 45) under the US percent<->proof convention.
    // CP-1 §5.3 names this exact string as the AMBIGUOUS_ABV demonstration case.
    const result = checkAbvStructural(abvField({ value: "45% Alc./Vol. (100 Proof)" }), 0.9, 45, 0);
    expect(result.hit).toBe(true);
  });

  it("a self-consistent percent and proof do not trigger the self-contradiction check", () => {
    const result = checkAbvStructural(abvField({ value: "45% Alc./Vol. (90 Proof)" }), 0.9, 45, 0);
    expect(result.hit).toBe(false);
  });

  it("fires when the value does not parse under the provisional ABV grammar", () => {
    const result = checkAbvStructural(abvField({ value: "not a percent or proof" }), 0.9, 45, 0);
    expect(result.hit).toBe(true);
  });

  it("fires when the field states two conflicting readings", () => {
    const result = checkAbvStructural(abvField({ alternates: ["45.5% Alc./Vol."] }), 0.9, 45, 0);
    expect(result.hit).toBe(true);
  });

  it("does not fire when an 'alternate' merely restates the same number — CP-1 §5.3 says CONFLICTING, not repeated", () => {
    const result = checkAbvStructural(abvField({ value: "45%", alternates: ["45.0%"] }), 0.9, 45, 0);
    expect(result.hit).toBe(false);
  });

  it("does not fire when an alternate restates the same value on the other axis — 45% and 90 Proof agree", () => {
    const result = checkAbvStructural(abvField({ value: "45%", alternates: ["90 Proof"] }), 0.9, 45, 0);
    expect(result.hit).toBe(false);
  });

  it("fires when an alternate genuinely disagrees across axes — 45% and 100 Proof (50%) do not", () => {
    const result = checkAbvStructural(abvField({ value: "45%", alternates: ["100 Proof"] }), 0.9, 45, 0);
    expect(result.hit).toBe(true);
  });

  it("still fires when an alternate does not parse at all — an unparsed 'second reading' is still a conflict", () => {
    const result = checkAbvStructural(abvField({ alternates: ["illegible smudge"] }), 0.9, 45, 0);
    expect(result.hit).toBe(true);
  });

  it("fires when the label exceeds tolerance vs. the application AND confidence is below 0.90", () => {
    const result = checkAbvStructural(abvField({ value: "40% Alc./Vol." }), 0.5, 45, 0);
    expect(result.hit).toBe(true);
  });

  it("does not fire on a tolerance excess when confidence is trusted enough (>= 0.90) — the asymmetry rule's own exception", () => {
    const result = checkAbvStructural(abvField({ value: "40% Alc./Vol." }), 0.95, 45, 0);
    expect(result.hit).toBe(false);
  });

  it("is false for a field with no value — that is MISSING_REQUIRED_FIELD's territory, not this check's", () => {
    const result = checkAbvStructural(abvField({ value: null }), 0.9, 45, 0);
    expect(result.hit).toBe(false);
  });

  it("fires the tolerance check on a PROOF-ONLY label too, not only a label that states a percent (CodeRabbit finding)", () => {
    // "80 Proof" states no percent directly — 80 proof is 40% (27 CFR 5.1).
    // The application declares 45%. Before this fix, the tolerance check
    // only ran when `parsed.percent !== null`, so a proof-only reading
    // silently skipped the application comparison entirely.
    const result = checkAbvStructural(abvField({ value: "80 Proof" }), 0.5, 45, 0);
    expect(result.hit).toBe(true);
  });

  it("does not fire the tolerance check on a proof-only label that agrees with the application", () => {
    const result = checkAbvStructural(abvField({ value: "90 Proof" }), 0.5, 45, 0);
    expect(result.hit).toBe(false);
  });
});

describe("checkNetContentsStructural — CP-1 §5.3 AMBIGUOUS_NET_CONTENTS", () => {
  const application = { netContentsValue: 750, netContentsUnit: "mL" };

  it("formatting alone is never a review — '750ml', '750 mL', '750 ML' all normalize the same", () => {
    for (const value of ["750ml", "750 mL", "750 ML"]) {
      const field: ExtractedField = { value, evidence: value, confidence: 0.9, alternates: [] };
      expect(checkNetContentsStructural(field, 0.9, application).hit).toBe(false);
    }
  });

  it("fires when the value does not parse into a number plus an accepted unit", () => {
    const field: ExtractedField = { value: "a lot", evidence: "a lot", confidence: 0.9, alternates: [] };
    expect(checkNetContentsStructural(field, 0.9, application).hit).toBe(true);
  });

  it("fires when the field states two conflicting readings", () => {
    const field: ExtractedField = { value: "750 mL", evidence: "750 mL", confidence: 0.9, alternates: ["1 L"] };
    expect(checkNetContentsStructural(field, 0.9, application).hit).toBe(true);
  });

  it("does not fire when an 'alternate' merely restates the same quantity in a different unit", () => {
    // 750 mL and 0.75 L are the same quantity, not a conflicting second reading.
    const field: ExtractedField = { value: "750 mL", evidence: "750 mL", confidence: 0.9, alternates: ["0.75 L"] };
    expect(checkNetContentsStructural(field, 0.9, application).hit).toBe(false);
  });

  it("fires when a unit conversion disagrees by more than the tolerance, below the confidence ceiling", () => {
    // 700 mL vs 750 mL is well past 0.5%.
    const field: ExtractedField = { value: "0.7 L", evidence: "0.7 L", confidence: 0.5, alternates: [] };
    expect(checkNetContentsStructural(field, 0.5, application).hit).toBe(true);
  });

  it("does not fire on a unit disagreement when confidence is trusted enough", () => {
    const field: ExtractedField = { value: "0.7 L", evidence: "0.7 L", confidence: 0.95, alternates: [] };
    expect(checkNetContentsStructural(field, 0.95, application).hit).toBe(false);
  });
});

function resolutionInput(overrides: Partial<ComparatorFieldResolutionInput> = {}): ComparatorFieldResolutionInput {
  return {
    field: "brand_name",
    required: true,
    overrideRejected: false,
    absent: false,
    lowImageQuality: false,
    comparatorResult: { verdict: "MATCH" },
    confidence: 0.95,
    structuralHit: false,
    ...overrides,
  };
}

describe("resolveComparatorField — CP-1 §5.2 precedence, one reason per field", () => {
  it("an override rejection wins over everything else: CONFLICTING_EXTRACTION", () => {
    const resolution = resolveComparatorField(resolutionInput({ overrideRejected: true, absent: true }));
    expect(resolution).toEqual({ verdict: "NEEDS_REVIEW", reviewReason: "CONFLICTING_EXTRACTION" });
  });

  it("a required, absent field (not overridden) is MISSING_REQUIRED_FIELD", () => {
    const resolution = resolveComparatorField(resolutionInput({ absent: true, comparatorResult: null }));
    expect(resolution).toEqual({ verdict: "NEEDS_REVIEW", reviewReason: "MISSING_REQUIRED_FIELD" });
  });

  it("MISSING_REQUIRED_FIELD does not fire when LOW_IMAGE_QUALITY already fired (CP-1 §5.3's own carve-out)", () => {
    const resolution = resolveComparatorField(
      resolutionInput({ absent: true, comparatorResult: null, lowImageQuality: true }),
    );
    expect(resolution.reviewReason).toBeNull();
    expect(resolution.verdict).toBe("NEEDS_REVIEW");
  });

  it("a clean MATCH with trusted confidence passes through with no review reason", () => {
    const resolution = resolveComparatorField(resolutionInput());
    expect(resolution).toEqual({ verdict: "MATCH", reviewReason: null, comparatorNote: undefined });
  });

  it("a MATCH at Unusable confidence (< 0.60) escalates to LOW_MODEL_CONFIDENCE — nothing more specific applies", () => {
    const resolution = resolveComparatorField(resolutionInput({ confidence: 0.4 }));
    expect(resolution.verdict).toBe("NEEDS_REVIEW");
    expect(resolution.reviewReason).toBe("LOW_MODEL_CONFIDENCE");
  });

  it("a MATCH in the Uncertain band (0.60-0.85) does not escalate — corroborated by agreement", () => {
    const resolution = resolveComparatorField(resolutionInput({ confidence: 0.7 }));
    expect(resolution.verdict).toBe("MATCH");
    expect(resolution.reviewReason).toBeNull();
  });

  it("a MISMATCH below 0.90 escalates to this field's own AMBIGUOUS_* reason", () => {
    const resolution = resolveComparatorField(
      resolutionInput({ comparatorResult: { verdict: "MISMATCH" }, confidence: 0.8 }),
    );
    expect(resolution.verdict).toBe("NEEDS_REVIEW");
    expect(resolution.reviewReason).toBe("AMBIGUOUS_BRAND");
  });

  it("class_type uses AMBIGUOUS_BRAND too — CP-1 §5.3: 'the same rule applies to class_type'", () => {
    const resolution = resolveComparatorField(
      resolutionInput({ field: "class_type", comparatorResult: { verdict: "NEEDS_REVIEW" } }),
    );
    expect(resolution.reviewReason).toBe("AMBIGUOUS_BRAND");
  });

  it("alcohol_content escalations use AMBIGUOUS_ABV", () => {
    const resolution = resolveComparatorField(
      resolutionInput({ field: "alcohol_content", comparatorResult: { verdict: "NEEDS_REVIEW" } }),
    );
    expect(resolution.reviewReason).toBe("AMBIGUOUS_ABV");
  });

  it("net_contents escalations use AMBIGUOUS_NET_CONTENTS", () => {
    const resolution = resolveComparatorField(
      resolutionInput({ field: "net_contents", comparatorResult: { verdict: "NEEDS_REVIEW" } }),
    );
    expect(resolution.reviewReason).toBe("AMBIGUOUS_NET_CONTENTS");
  });

  it("a structural hit escalates even when the comparator itself says MATCH", () => {
    const resolution = resolveComparatorField(
      resolutionInput({ field: "alcohol_content", comparatorResult: { verdict: "MATCH" }, structuralHit: true }),
    );
    expect(resolution.verdict).toBe("NEEDS_REVIEW");
    expect(resolution.reviewReason).toBe("AMBIGUOUS_ABV");
  });

  it("a not-required, absent field is a clean MATCH — nothing to check", () => {
    const resolution = resolveComparatorField(resolutionInput({ required: false, absent: true, comparatorResult: null }));
    expect(resolution).toEqual({ verdict: "MATCH", reviewReason: null });
  });
});

describe("resolveGovernmentWarningField — the WARNING_MISMATCH contract (CP-1 §5.3)", () => {
  it("an override rejection wins: CONFLICTING_EXTRACTION", () => {
    const resolution = resolveGovernmentWarningField({
      required: true,
      overrideRejected: true,
      absent: false,
      lowImageQuality: false,
      warningResult: null,
    });
    expect(resolution).toEqual({ verdict: "NEEDS_REVIEW", reviewReason: "CONFLICTING_EXTRACTION" });
  });

  it("a required, absent warning is MISSING_REQUIRED_FIELD", () => {
    const resolution = resolveGovernmentWarningField({
      required: true,
      overrideRejected: false,
      absent: true,
      lowImageQuality: false,
      warningResult: null,
    });
    expect(resolution).toEqual({ verdict: "NEEDS_REVIEW", reviewReason: "MISSING_REQUIRED_FIELD" });
  });

  it("passes through the comparator's PASS as MATCH with no review reason", () => {
    const resolution = resolveGovernmentWarningField({
      required: true,
      overrideRejected: false,
      absent: false,
      lowImageQuality: false,
      warningResult: { verdict: "MATCH" },
    });
    expect(resolution.verdict).toBe("MATCH");
    expect(resolution.reviewReason).toBeNull();
  });

  it("passes through the comparator's FAIL as MISMATCH, e.g. TITLE_CASE prefix (Jenny's catch)", () => {
    const resolution = resolveGovernmentWarningField({
      required: true,
      overrideRejected: false,
      absent: false,
      lowImageQuality: false,
      warningResult: { verdict: "MISMATCH", note: "The warning prefix is not ALL CAPS." },
    });
    expect(resolution.verdict).toBe("MISMATCH");
    expect(resolution.reviewReason).toBeNull();
    expect(resolution.comparatorNote).toBe("The warning prefix is not ALL CAPS.");
  });

  it("uses the comparator's own reviewReason for a REVIEW verdict", () => {
    const resolution = resolveGovernmentWarningField({
      required: true,
      overrideRejected: false,
      absent: false,
      lowImageQuality: false,
      warningResult: { verdict: "NEEDS_REVIEW", reviewReason: "LOW_IMAGE_QUALITY" },
    });
    expect(resolution.reviewReason).toBe("LOW_IMAGE_QUALITY");
  });

  it("passes through WARNING_MISMATCH when the comparator states it explicitly", () => {
    const resolution = resolveGovernmentWarningField({
      required: true,
      overrideRejected: false,
      absent: false,
      lowImageQuality: false,
      warningResult: { verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH" },
    });
    expect(resolution.reviewReason).toBe("WARNING_MISMATCH");
  });

  // `WarningComparatorResult` is a discriminated union (types.ts):
  // `reviewReason` is REQUIRED on the NEEDS_REVIEW branch and does not
  // exist on the MATCH/MISMATCH branches. `{ verdict: "NEEDS_REVIEW" }`
  // with no `reviewReason` is a compile error, not a runtime default to
  // test — CP-1 §5.3's contract always names a reason for a REVIEW result.
});
