import { describe, expect, it } from "vitest";
import { testExtraction, testGoldenCase } from "./test-support";
import { scoreVerdict, type ActualVerdict } from "./verdict-scoring";

const ALL_MATCH_FIELDS: ActualVerdict["fields"] = [
  { field: "brand_name", verdict: "MATCH" },
  { field: "class_type", verdict: "MATCH" },
  { field: "alcohol_content", verdict: "MATCH" },
  { field: "net_contents", verdict: "MATCH" },
  { field: "government_warning", verdict: "MATCH" },
];

describe("scoreVerdict", () => {
  it("scores a clean PASS as fully correct", () => {
    const result = scoreVerdict(testGoldenCase(), { labelVerdict: "PASS", headlineReason: null, fields: ALL_MATCH_FIELDS }, testExtraction());
    expect(result.labelVerdictCorrect).toBe(true);
    expect(result.reviewReasonCorrect).toBe(true);
    expect(result.fields.every((f) => f.correct)).toBe(true);
  });

  it("scores an ABV mismatch case (FAIL) as correct when the system also FAILs on ABV", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      expected: {
        labelVerdict: "FAIL",
        fields: {
          ...base.expected.fields,
          abv: { verdict: "MISMATCH", reason: "differs" },
        },
      },
    });
    const actual: ActualVerdict = {
      labelVerdict: "FAIL",
      headlineReason: null,
      fields: [
        { field: "brand_name", verdict: "MATCH" },
        { field: "class_type", verdict: "MATCH" },
        { field: "alcohol_content", verdict: "MISMATCH" },
        { field: "net_contents", verdict: "MATCH" },
        { field: "government_warning", verdict: "MATCH" },
      ],
    };
    const result = scoreVerdict(caseSpec, actual, testExtraction());
    expect(result.labelVerdictCorrect).toBe(true);
    expect(result.fields.find((f) => f.field === "alcohol_content")?.correct).toBe(true);
  });

  it("scores a REVIEW case as correct when the system escalates with the matching reason", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      expected: {
        labelVerdict: "REVIEW",
        reviewReason: "LOW_IMAGE_QUALITY",
        fields: {
          ...base.expected.fields,
          brandName: { verdict: "NEEDS_REVIEW", reason: "glare" },
        },
      },
    });
    const actual: ActualVerdict = {
      labelVerdict: "REVIEW",
      headlineReason: "LOW_IMAGE_QUALITY",
      fields: [
        { field: "brand_name", verdict: "NEEDS_REVIEW", reviewReason: "LOW_IMAGE_QUALITY" },
        { field: "class_type", verdict: "MATCH" },
        { field: "alcohol_content", verdict: "MATCH" },
        { field: "net_contents", verdict: "MATCH" },
        { field: "government_warning", verdict: "MATCH" },
      ],
    };
    const result = scoreVerdict(caseSpec, actual, testExtraction());
    expect(result.labelVerdictCorrect).toBe(true);
    expect(result.reviewReasonCorrect).toBe(true);
    expect(result.fields.find((f) => f.field === "brand_name")?.actualReviewReason).toBe("LOW_IMAGE_QUALITY");
  });

  it("scores a REVIEW case as label-correct-but-reason-wrong when the reason disagrees", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      expected: {
        labelVerdict: "REVIEW",
        reviewReason: "LOW_IMAGE_QUALITY",
        fields: {
          ...base.expected.fields,
          brandName: { verdict: "NEEDS_REVIEW", reason: "glare" },
        },
      },
    });
    const actual: ActualVerdict = {
      labelVerdict: "REVIEW",
      headlineReason: "LOW_MODEL_CONFIDENCE",
      fields: [
        { field: "brand_name", verdict: "NEEDS_REVIEW", reviewReason: "LOW_MODEL_CONFIDENCE" },
        { field: "class_type", verdict: "MATCH" },
        { field: "alcohol_content", verdict: "MATCH" },
        { field: "net_contents", verdict: "MATCH" },
        { field: "government_warning", verdict: "MATCH" },
      ],
    };
    const result = scoreVerdict(caseSpec, actual, testExtraction());
    expect(result.labelVerdictCorrect).toBe(true);
    expect(result.reviewReasonCorrect).toBe(false);
  });

  it("scores labelVerdict as incorrect when the system passes a case the golden set expects to FAIL", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      expected: {
        labelVerdict: "FAIL",
        fields: { ...base.expected.fields, abv: { verdict: "MISMATCH", reason: "differs" } },
      },
    });
    const actual: ActualVerdict = { labelVerdict: "PASS", headlineReason: null, fields: ALL_MATCH_FIELDS };
    const result = scoreVerdict(caseSpec, actual, testExtraction());
    expect(result.labelVerdictCorrect).toBe(false);
  });

  it("does not penalize reviewReasonCorrect on a PASS/FAIL case even when headlineReason differs (both should be null)", () => {
    const result = scoreVerdict(testGoldenCase(), { labelVerdict: "PASS", headlineReason: null, fields: ALL_MATCH_FIELDS }, testExtraction());
    expect(result.reviewReasonCorrect).toBe(true);
  });

  it("throws when actual.fields is missing a required field", () => {
    const incomplete: ActualVerdict = {
      labelVerdict: "PASS",
      headlineReason: null,
      fields: ALL_MATCH_FIELDS.filter((f) => f.field !== "government_warning"),
    };
    expect(() => scoreVerdict(testGoldenCase(), incomplete, testExtraction())).toThrow(/no entry for "government_warning"/);
  });

  it("throws when actual.fields has a duplicate field entry, rather than silently dropping one", () => {
    const duplicated: ActualVerdict = {
      labelVerdict: "PASS",
      headlineReason: null,
      fields: [...ALL_MATCH_FIELDS, { field: "brand_name", verdict: "MISMATCH" }],
    };
    expect(() => scoreVerdict(testGoldenCase(), duplicated, testExtraction())).toThrow(/duplicate field entries/);
  });

  it("sets actualReviewReason to null on every MATCH/MISMATCH field, never leftover from a different field's reason", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      expected: {
        labelVerdict: "FAIL",
        fields: { ...base.expected.fields, abv: { verdict: "MISMATCH", reason: "differs" } },
      },
    });
    const actual: ActualVerdict = {
      labelVerdict: "FAIL",
      headlineReason: null,
      fields: [
        { field: "brand_name", verdict: "MATCH" },
        { field: "class_type", verdict: "MATCH" },
        { field: "alcohol_content", verdict: "MISMATCH" },
        { field: "net_contents", verdict: "MATCH" },
        { field: "government_warning", verdict: "MATCH" },
      ],
    };
    const result = scoreVerdict(caseSpec, actual, testExtraction());
    for (const field of result.fields) {
      expect(field.actualReviewReason, `${field.field} should carry no reviewReason`).toBeNull();
    }
  });

  it("accepts a NEEDS_REVIEW field with reviewReason: null — a real, observed router shape (case-20's --live --full run), not a hypothetical", () => {
    // resolveGovernmentWarningField/resolveComparatorField's own carve-out
    // (CP-1 §5.3): a required, absent field on a label that already
    // carries a LOW_IMAGE_QUALITY blocker resolves to NEEDS_REVIEW with no
    // reviewReason of its own, to avoid a redundant, misleading
    // MISSING_REQUIRED_FIELD once the true cause is already named at the
    // label level. ActualFieldOutcome's NEEDS_REVIEW branch must accept
    // this without throwing (see its own doc comment for the full story).
    const actual: ActualVerdict = {
      labelVerdict: "REVIEW",
      headlineReason: "LOW_IMAGE_QUALITY",
      fields: [
        { field: "brand_name", verdict: "NEEDS_REVIEW", reviewReason: null },
        { field: "class_type", verdict: "NEEDS_REVIEW", reviewReason: null },
        { field: "alcohol_content", verdict: "NEEDS_REVIEW", reviewReason: null },
        { field: "net_contents", verdict: "NEEDS_REVIEW", reviewReason: null },
        { field: "government_warning", verdict: "NEEDS_REVIEW", reviewReason: null },
      ],
    };
    const result = scoreVerdict(testGoldenCase(), actual, testExtraction());
    expect(result.fields.find((f) => f.field === "brand_name")?.actualReviewReason).toBeNull();
    expect(result.fields.find((f) => f.field === "government_warning")?.actualReviewReason).toBeNull();
  });

  it("carries warningChannel through onto the case score when the caller supplies one (TRO-535 / LH-030b)", () => {
    const actual: ActualVerdict = { labelVerdict: "PASS", headlineReason: null, fields: ALL_MATCH_FIELDS, warningChannel: "single" };
    const result = scoreVerdict(testGoldenCase(), actual, testExtraction());
    expect(result.warningChannel).toBe("single");
  });

  it("normalizes an absent warningChannel to null, never undefined — the Sonnet-only benchmark arm never sets it", () => {
    const result = scoreVerdict(testGoldenCase(), { labelVerdict: "PASS", headlineReason: null, fields: ALL_MATCH_FIELDS }, testExtraction());
    expect(result.warningChannel).toBeNull();
  });

  it("threads government_warning's own actualReviewReason through independently of the label headlineReason — TRO-469's warning-segmentation input", () => {
    // The real, observed shape from case-11's live run (CHANGES.md TRO-470):
    // the label escalates on a DIFFERENT field's blocker while
    // government_warning's own field verdict is a confident MISMATCH with
    // no reviewReason of its own — segmentWarningCheckOutcomes must read
    // THIS field's own outcome, not the label's headlineReason.
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      expected: {
        labelVerdict: "FAIL",
        fields: { ...base.expected.fields, governmentWarning: { verdict: "MISMATCH", reason: "reworded" } },
      },
    });
    const actual: ActualVerdict = {
      labelVerdict: "REVIEW",
      headlineReason: "CONFLICTING_EXTRACTION",
      fields: [
        { field: "brand_name", verdict: "NEEDS_REVIEW", reviewReason: "CONFLICTING_EXTRACTION" },
        { field: "class_type", verdict: "MATCH" },
        { field: "alcohol_content", verdict: "MATCH" },
        { field: "net_contents", verdict: "MATCH" },
        { field: "government_warning", verdict: "MISMATCH" },
      ],
    };
    const result = scoreVerdict(caseSpec, actual, testExtraction());
    const warningField = result.fields.find((f) => f.field === "government_warning");
    expect(warningField?.actualVerdict).toBe("MISMATCH");
    expect(warningField?.actualReviewReason).toBeNull();
  });

  it("records each field's own confidence from the captured extraction, never a single shared number (TRO-538 / LH-033)", () => {
    const extraction = testExtraction({
      brand_name: { value: "Old Tom Distillery", evidence: "Old Tom Distillery", confidence: 0.42, alternates: [] },
      government_warning: {
        present: true,
        transcription: "x",
        prefix_casing: "ALL_CAPS",
        formatting: { bold: "uncertain" },
        evidence: "x",
        confidence: 0.81,
      },
    });
    const result = scoreVerdict(testGoldenCase(), { labelVerdict: "PASS", headlineReason: null, fields: ALL_MATCH_FIELDS }, extraction);
    expect(result.fields.find((f) => f.field === "brand_name")?.confidence).toBe(0.42);
    expect(result.fields.find((f) => f.field === "government_warning")?.confidence).toBe(0.81);
    // class_type was not overridden — still the test-support default, and
    // distinct from brand_name's, proving this isn't one number copied
    // across every field.
    expect(result.fields.find((f) => f.field === "class_type")?.confidence).toBe(0.95);
  });
});
