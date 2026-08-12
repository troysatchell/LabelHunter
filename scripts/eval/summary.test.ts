import { describe, expect, it } from "vitest";
import type { ExtractionCaseScore, VerdictCaseScore } from "./types";
import { buildEvalReportSummary, summarize, summarizeExtraction, summarizeVerdict } from "./summary";

describe("summarize", () => {
  it("computes a rate from total/correct", () => {
    expect(summarize(4, 3)).toEqual({ total: 4, correct: 3, rate: 0.75 });
  });

  it("returns rate 0 on an empty population, never NaN", () => {
    expect(summarize(0, 0)).toEqual({ total: 0, correct: 0, rate: 0 });
  });
});

function extractionCase(caseId: string, correctFlags: [boolean, boolean, boolean, boolean, boolean]): ExtractionCaseScore {
  const [brand, cls, abv, net, warning] = correctFlags;
  return {
    caseId,
    category: "clean-match",
    fields: [
      { field: "brandName", correct: brand, expected: "x", actual: "x", detail: "" },
      { field: "classType", correct: cls, expected: "x", actual: "x", detail: "" },
      { field: "abv", correct: abv, expected: "x", actual: "x", detail: "" },
      { field: "netContents", correct: net, expected: "x", actual: "x", detail: "" },
      { field: "governmentWarning", correct: warning, expected: "x", actual: "x", detail: "" },
    ],
  };
}

describe("summarizeExtraction", () => {
  it("scores overall accuracy as correct fields over total fields, not correct cases", () => {
    const cases = [
      extractionCase("a", [true, true, true, true, true]),
      extractionCase("b", [true, false, true, true, true]),
    ];
    const result = summarizeExtraction(cases);
    // 9 of 10 fields correct, even though only 1 of 2 cases is perfect.
    expect(result.overall).toEqual({ total: 10, correct: 9, rate: 0.9 });
  });

  it("breaks accuracy down per field", () => {
    const cases = [
      extractionCase("a", [true, true, true, true, true]),
      extractionCase("b", [false, true, true, true, true]),
    ];
    const result = summarizeExtraction(cases);
    expect(result.byField.brandName).toEqual({ total: 2, correct: 1, rate: 0.5 });
    expect(result.byField.classType).toEqual({ total: 2, correct: 2, rate: 1 });
  });

  it("returns zeroed summaries on an empty case list", () => {
    const result = summarizeExtraction([]);
    expect(result.overall).toEqual({ total: 0, correct: 0, rate: 0 });
    expect(result.byField.abv).toEqual({ total: 0, correct: 0, rate: 0 });
  });
});

/** A wrong verdict, guaranteed different from `expected` — cycles through
 * PASS/FAIL/REVIEW rather than hard-coding "REVIEW" (which silently
 * produced a "wrong" verdict identical to `expected` whenever `expected`
 * itself was "REVIEW" — a PR review finding in the fixture, not in the
 * code under test). */
function aDifferentVerdict(expected: "PASS" | "FAIL" | "REVIEW"): "PASS" | "FAIL" | "REVIEW" {
  return expected === "REVIEW" ? "PASS" : "REVIEW";
}

function verdictCase(
  caseId: string,
  opts: { labelCorrect: boolean; reviewReasonCorrect: boolean; expectedLabelVerdict: "PASS" | "FAIL" | "REVIEW"; fieldCorrect: boolean },
): VerdictCaseScore {
  return {
    caseId,
    category: "clean-match",
    expectedLabelVerdict: opts.expectedLabelVerdict,
    actualLabelVerdict: opts.labelCorrect ? opts.expectedLabelVerdict : aDifferentVerdict(opts.expectedLabelVerdict),
    labelVerdictCorrect: opts.labelCorrect,
    expectedReviewReason: opts.expectedLabelVerdict === "REVIEW" ? "LOW_IMAGE_QUALITY" : null,
    actualReviewReason: opts.expectedLabelVerdict === "REVIEW" && opts.reviewReasonCorrect ? "LOW_IMAGE_QUALITY" : null,
    reviewReasonCorrect: opts.reviewReasonCorrect,
    fields: [
      { field: "brand_name", expectedVerdict: "MATCH", actualVerdict: opts.fieldCorrect ? "MATCH" : "MISMATCH", correct: opts.fieldCorrect },
    ],
  };
}

describe("summarizeVerdict", () => {
  it("scores label-verdict accuracy across every case", () => {
    const cases = [
      verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true }),
      verdictCase("b", { labelCorrect: false, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true }),
    ];
    expect(summarizeVerdict(cases).labelVerdictAccuracy).toEqual({ total: 2, correct: 1, rate: 0.5 });
  });

  it("scores reviewReasonAccuracy only over cases the golden set expects to REVIEW", () => {
    const cases = [
      verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true }),
      verdictCase("b", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "REVIEW", fieldCorrect: true }),
      verdictCase("c", { labelCorrect: true, reviewReasonCorrect: false, expectedLabelVerdict: "REVIEW", fieldCorrect: true }),
    ];
    // Two REVIEW cases, one with the right reason -> 1/2, not 2/3.
    expect(summarizeVerdict(cases).reviewReasonAccuracy).toEqual({ total: 2, correct: 1, rate: 0.5 });
  });

  it("breaks field-verdict accuracy down per router field", () => {
    const cases = [verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: false })];
    expect(summarizeVerdict(cases).fieldVerdictAccuracyByField.brand_name).toEqual({ total: 1, correct: 0, rate: 0 });
    expect(summarizeVerdict(cases).fieldVerdictAccuracyByField.class_type).toEqual({ total: 0, correct: 0, rate: 0 });
  });
});

describe("buildEvalReportSummary", () => {
  it("combines extraction and verdict summaries into one report summary shape", () => {
    const extractionCases = [extractionCase("a", [true, true, true, true, true])];
    const verdictCases = [verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true })];
    const summary = buildEvalReportSummary(extractionCases, verdictCases);
    expect(summary.extractionAccuracy).toEqual({ total: 5, correct: 5, rate: 1 });
    expect(summary.labelVerdictAccuracy).toEqual({ total: 1, correct: 1, rate: 1 });
    expect(summary.reviewReasonAccuracy).toEqual({ total: 0, correct: 0, rate: 0 });
  });
});
