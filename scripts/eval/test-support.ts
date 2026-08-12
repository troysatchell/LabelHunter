/**
 * Shared test fixtures for the eval harness's own test suite (LH-030 /
 * TRO-470) — the same "one builder, several test files" convention as
 * `src/server/router/test-support.ts` and `src/server/resolver/test-support.ts`.
 * Not imported by any non-test file.
 */
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import type { ExtractedField, HaikuExtractionResult } from "../../src/server/extractor/types";

export function testField(value: string | null, overrides: Partial<ExtractedField> = {}): ExtractedField {
  return { value, evidence: value ?? "", confidence: 0.95, alternates: [], ...overrides };
}

const CANONICAL_WARNING_TEXT_FIXTURE =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

/** A minimal, valid golden-set case — spirits, every field a clean match.
 * Tests override only what they need to exercise (`{ ...goldenCase(), label: {...} }`
 * or the `overrides` param — both work; the param exists for the common
 * one-or-two-field override case). */
export function testGoldenCase(overrides: Partial<GoldenSetCase> = {}): GoldenSetCase {
  return {
    caseId: "case-test",
    description: "test case",
    category: "clean-match",
    beverageType: "spirits",
    imagePath: "golden-set/images/case-test.jpg",
    provenance: "rendered",
    verified: false,
    vectors: [],
    application: {
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      abvPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    },
    label: {
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      abvPresent: true,
      abvText: "45% Alc./Vol. (90 Proof)",
      abvPercent: 45,
      proof: 90,
      netContentsText: "750 mL",
      netContentsValue: 750,
      netContentsUnit: "mL",
      governmentWarningPresent: true,
      governmentWarningText: CANONICAL_WARNING_TEXT_FIXTURE,
      governmentWarningPrefixAllCaps: true,
    },
    expected: {
      labelVerdict: "PASS",
      fields: {
        brandName: { verdict: "MATCH", reason: "matches" },
        classType: { verdict: "MATCH", reason: "matches" },
        abv: { verdict: "MATCH", reason: "matches" },
        netContents: { verdict: "MATCH", reason: "matches" },
        governmentWarning: { verdict: "MATCH", reason: "matches" },
      },
    },
    ...overrides,
  };
}

export function testExtraction(overrides: Partial<HaikuExtractionResult> = {}): HaikuExtractionResult {
  return {
    image_quality: { legible: "yes", issues: ["none"], confidence: 0.95 },
    brand_name: testField("Old Tom Distillery"),
    class_type: testField("Straight Bourbon Whiskey"),
    alcohol_content: testField("45% Alc./Vol. (90 Proof)"),
    net_contents: testField("750 mL"),
    beverage_type: testField("spirits"),
    government_warning: {
      present: true,
      transcription: CANONICAL_WARNING_TEXT_FIXTURE,
      prefix_casing: "ALL_CAPS",
      formatting: { bold: "uncertain" },
      evidence: "GOVERNMENT WARNING",
      confidence: 0.97,
    },
    ...overrides,
  };
}
