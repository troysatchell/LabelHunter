import { describe, expect, it } from "vitest";
import type { ExtractionCaseScore, ExtractionFieldScore, VerdictCaseScore } from "./types";
import { buildEvalReportSummary, buildExtractionReliabilityDiagram, summarize, summarizeExtraction, summarizeVerdict } from "./summary";

describe("summarize", () => {
  it("computes a rate from total/correct", () => {
    expect(summarize(4, 3)).toEqual({ total: 4, correct: 3, rate: 0.75 });
  });

  it("returns rate 0 on an empty population, never NaN", () => {
    expect(summarize(0, 0)).toEqual({ total: 0, correct: 0, rate: 0 });
  });
});

function extractionCase(
  caseId: string,
  correctFlags: [boolean, boolean, boolean, boolean, boolean],
  confidences: [number, number, number, number, number] = [0.9, 0.9, 0.9, 0.9, 0.9],
): ExtractionCaseScore {
  const [brand, cls, abv, net, warning] = correctFlags;
  const [brandConf, clsConf, abvConf, netConf, warningConf] = confidences;
  return {
    caseId,
    category: "clean-match",
    fields: [
      { field: "brandName", correct: brand, expected: "x", actual: "x", confidence: brandConf, detail: "" },
      { field: "classType", correct: cls, expected: "x", actual: "x", confidence: clsConf, detail: "" },
      { field: "abv", correct: abv, expected: "x", actual: "x", confidence: abvConf, detail: "" },
      { field: "netContents", correct: net, expected: "x", actual: "x", confidence: netConf, detail: "" },
      { field: "governmentWarning", correct: warning, expected: "x", actual: "x", confidence: warningConf, detail: "" },
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
  opts: {
    labelCorrect: boolean;
    reviewReasonCorrect: boolean;
    expectedLabelVerdict: "PASS" | "FAIL" | "REVIEW";
    fieldCorrect: boolean;
    /** TRO-535 / LH-030b. Defaults to `null` — most fixtures do not
     * exercise the warning subsystem's own channel; the dedicated test
     * below and `warning-segmentation.test.ts` cover `singleChannelPass`
     * directly. */
    warningChannel?: VerdictCaseScore["warningChannel"];
  },
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
    warningChannel: opts.warningChannel ?? null,
    lowImageQualityTrigger:
      opts.expectedLabelVerdict === "REVIEW" && opts.reviewReasonCorrect ? "FIELDS_ABSENT" : null,
    fields: [
      {
        field: "brand_name",
        expectedVerdict: "MATCH",
        actualVerdict: opts.fieldCorrect ? "MATCH" : "MISMATCH",
        correct: opts.fieldCorrect,
        confidence: 0.9,
        actualReviewReason: null,
      },
      // Every case needs its own government_warning row —
      // segmentWarningCheckOutcomes (called inside summarizeVerdict) reads
      // it for every case in the run, TRO-469 / LH-021. A plain MATCH here
      // keeps these fixtures focused on what each test actually asserts.
      { field: "government_warning", expectedVerdict: "MATCH", actualVerdict: "MATCH", correct: true, confidence: 0.9, actualReviewReason: null },
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

  it("includes the warning-check segmentation (TRO-469 / LH-021, PRD §3.7) — every fixture case's government_warning row is a clean MATCH", () => {
    const cases = [
      verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true }),
      verdictCase("b", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true }),
    ];
    expect(summarizeVerdict(cases).warningSegmentation).toEqual({
      total: 2,
      clean: { count: 2, rate: 1 },
      trueMismatch: { count: 0, rate: 0 },
      resolutionSuspect: { count: 0, rate: 0 },
      notFound: { count: 0, rate: 0 },
      singleChannelPass: { count: 0, rate: 0 },
    });
  });

  it("carries singleChannelPass through end to end when a case's clean pass ran on a single channel (TRO-535 / LH-030b, CP-2 §8.4's residual false-PASS exposure)", () => {
    const cases = [
      verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true, warningChannel: "single" }),
      verdictCase("b", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true, warningChannel: "dual" }),
    ];
    const segmentation = summarizeVerdict(cases).warningSegmentation;
    expect(segmentation.clean).toEqual({ count: 2, rate: 1 });
    expect(segmentation.singleChannelPass).toEqual({ count: 1, rate: 0.5 });
  });
});

function extractionFieldScore(field: ExtractionFieldScore["field"], confidence: number, correct: boolean): ExtractionFieldScore {
  return { field, correct, confidence, expected: "x", actual: correct ? "x" : "y", detail: "" };
}

describe("buildExtractionReliabilityDiagram", () => {
  it("buckets a field into the decile its confidence rounds down into", () => {
    const diagram = buildExtractionReliabilityDiagram([extractionFieldScore("brandName", 0.73, true)]);
    expect(diagram[7]).toEqual({ decile: 7, n: 1, correct: 1, rate: 1 });
    expect(diagram[6].n).toBe(0);
    expect(diagram[8].n).toBe(0);
  });

  it("puts a confidence of exactly 1.0 in the last bucket, not a create-the-11th-bucket overflow", () => {
    const diagram = buildExtractionReliabilityDiagram([extractionFieldScore("abv", 1.0, true)]);
    expect(diagram).toHaveLength(10);
    expect(diagram[9]).toEqual({ decile: 9, n: 1, correct: 1, rate: 1 });
  });

  it("reports each bucket's own rate independently, with n beside it", () => {
    const diagram = buildExtractionReliabilityDiagram([
      extractionFieldScore("brandName", 0.2, true),
      extractionFieldScore("classType", 0.21, false),
      extractionFieldScore("abv", 0.9, true),
    ]);
    expect(diagram[2]).toEqual({ decile: 2, n: 2, correct: 1, rate: 0.5 });
    expect(diagram[9]).toEqual({ decile: 9, n: 1, correct: 1, rate: 1 });
  });

  it("returns all 10 deciles, zeroed, on an empty field list — never a shorter array", () => {
    const diagram = buildExtractionReliabilityDiagram([]);
    expect(diagram).toHaveLength(10);
    expect(diagram.every((bucket) => bucket.n === 0 && bucket.rate === 0)).toBe(true);
  });

  it("normalizes a non-finite confidence (NaN) to bucket 0 instead of crashing on buckets[NaN] (CodeRabbit finding, TRO-538 triage)", () => {
    const diagram = buildExtractionReliabilityDiagram([extractionFieldScore("brandName", NaN, true)]);
    expect(diagram[0]).toEqual({ decile: 0, n: 1, correct: 1, rate: 1 });
    expect(diagram.slice(1).every((bucket) => bucket.n === 0)).toBe(true);
  });

  it("clamps a finite but out-of-range confidence (below 0) into the first bucket — the pre-existing Math.max(0, ...) clamp, confirmed still correct", () => {
    const diagram = buildExtractionReliabilityDiagram([extractionFieldScore("brandName", -0.5, true)]);
    expect(diagram[0]).toEqual({ decile: 0, n: 1, correct: 1, rate: 1 });
  });
});

describe("buildEvalReportSummary", () => {
  it("combines extraction and router-verdict summaries into one report summary shape", () => {
    const extractionCases = [extractionCase("a", [true, true, true, true, true])];
    const verdictCases = [verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true })];
    const summary = buildEvalReportSummary(extractionCases, verdictCases, verdictCases);
    expect(summary.extractionAccuracy).toEqual({ total: 5, correct: 5, rate: 1 });
    expect(summary.routerVerdictAccuracy).toEqual({ total: 1, correct: 1, rate: 1 });
    expect(summary.reviewReasonAccuracy).toEqual({ total: 0, correct: 0, rate: 0 });
  });

  it("scores cascadeVerdictAccuracy from its OWN case list, independently of routerVerdictCases (TRO-538 / LH-033)", () => {
    const extractionCases = [extractionCase("a", [true, true, true, true, true])];
    const routerCases = [verdictCase("a", { labelCorrect: false, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true })];
    const cascadeCases = [verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true })];
    const summary = buildEvalReportSummary(extractionCases, routerCases, cascadeCases);
    expect(summary.routerVerdictAccuracy).toEqual({ total: 1, correct: 0, rate: 0 });
    expect(summary.cascadeVerdictAccuracy).toEqual({ total: 1, correct: 1, rate: 1 });
  });

  it("builds a 10-bucket extractionReliabilityDiagram from the extraction cases alone", () => {
    const extractionCases = [extractionCase("a", [true, true, true, true, true], [0.95, 0.95, 0.95, 0.95, 0.95])];
    const verdictCases = [verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true })];
    const summary = buildEvalReportSummary(extractionCases, verdictCases, verdictCases);
    expect(summary.extractionReliabilityDiagram).toHaveLength(10);
    expect(summary.extractionReliabilityDiagram[9]).toEqual({ decile: 9, n: 5, correct: 5, rate: 1 });
    expect(summary.extractionReliabilityDiagram[0]).toEqual({ decile: 0, n: 0, correct: 0, rate: 0 });
  });

  it("carries warningSegmentation through from summarizeVerdict (TRO-469 / LH-021)", () => {
    const extractionCases = [extractionCase("a", [true, true, true, true, true])];
    const verdictCases = [verdictCase("a", { labelCorrect: true, reviewReasonCorrect: true, expectedLabelVerdict: "PASS", fieldCorrect: true })];
    const summary = buildEvalReportSummary(extractionCases, verdictCases, verdictCases);
    expect(summary.warningSegmentation).toEqual({
      total: 1,
      clean: { count: 1, rate: 1 },
      trueMismatch: { count: 0, rate: 0 },
      resolutionSuspect: { count: 0, rate: 0 },
      notFound: { count: 0, rate: 0 },
      singleChannelPass: { count: 0, rate: 0 },
    });
  });
});
