import { describe, expect, it } from "vitest";
import { testGoldenCase } from "./test-support";
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
    const result = scoreVerdict(testGoldenCase(), { labelVerdict: "PASS", headlineReason: null, fields: ALL_MATCH_FIELDS });
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
    const result = scoreVerdict(caseSpec, actual);
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
        { field: "brand_name", verdict: "NEEDS_REVIEW" },
        { field: "class_type", verdict: "MATCH" },
        { field: "alcohol_content", verdict: "MATCH" },
        { field: "net_contents", verdict: "MATCH" },
        { field: "government_warning", verdict: "MATCH" },
      ],
    };
    const result = scoreVerdict(caseSpec, actual);
    expect(result.labelVerdictCorrect).toBe(true);
    expect(result.reviewReasonCorrect).toBe(true);
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
        { field: "brand_name", verdict: "NEEDS_REVIEW" },
        { field: "class_type", verdict: "MATCH" },
        { field: "alcohol_content", verdict: "MATCH" },
        { field: "net_contents", verdict: "MATCH" },
        { field: "government_warning", verdict: "MATCH" },
      ],
    };
    const result = scoreVerdict(caseSpec, actual);
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
    const result = scoreVerdict(caseSpec, actual);
    expect(result.labelVerdictCorrect).toBe(false);
  });

  it("does not penalize reviewReasonCorrect on a PASS/FAIL case even when headlineReason differs (both should be null)", () => {
    const result = scoreVerdict(testGoldenCase(), { labelVerdict: "PASS", headlineReason: null, fields: ALL_MATCH_FIELDS });
    expect(result.reviewReasonCorrect).toBe(true);
  });

  it("throws when actual.fields is missing a required field", () => {
    const incomplete: ActualVerdict = {
      labelVerdict: "PASS",
      headlineReason: null,
      fields: ALL_MATCH_FIELDS.filter((f) => f.field !== "government_warning"),
    };
    expect(() => scoreVerdict(testGoldenCase(), incomplete)).toThrow(/no entry for "government_warning"/);
  });

  it("throws when actual.fields has a duplicate field entry, rather than silently dropping one", () => {
    const duplicated: ActualVerdict = {
      labelVerdict: "PASS",
      headlineReason: null,
      fields: [...ALL_MATCH_FIELDS, { field: "brand_name", verdict: "MISMATCH" }],
    };
    expect(() => scoreVerdict(testGoldenCase(), duplicated)).toThrow(/duplicate field entries/);
  });
});
