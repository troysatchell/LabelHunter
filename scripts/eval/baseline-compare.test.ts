import { describe, expect, it } from "vitest";
import { compareToBaseline, type RegressionCheckInput } from "./baseline-compare";
import type { EvalBaseline, EvalReportSummary } from "./types";

function summary(overrides: Partial<EvalReportSummary> = {}): EvalReportSummary {
  const rate = { total: 10, correct: 9, rate: 0.9 };
  return {
    extractionAccuracy: rate,
    extractionAccuracyByField: {
      brandName: rate,
      classType: rate,
      abv: rate,
      netContents: rate,
      governmentWarning: rate,
    },
    labelVerdictAccuracy: rate,
    fieldVerdictAccuracyByField: {
      brand_name: rate,
      class_type: rate,
      alcohol_content: rate,
      net_contents: rate,
      government_warning: rate,
    },
    reviewReasonAccuracy: rate,
    warningSegmentation: {
      total: 10,
      clean: { count: 8, rate: 0.8 },
      trueMismatch: { count: 1, rate: 0.1 },
      resolutionSuspect: { count: 1, rate: 0.1 },
      notFound: { count: 0, rate: 0 },
    },
    ...overrides,
  };
}

function baseline(overrides: Partial<EvalBaseline> = {}): EvalBaseline {
  return {
    ticket: "TRO-470",
    establishedAt: "2026-08-11T00:00:00.000Z",
    manifestVersion: "1.0.0",
    caseIds: ["case-01", "case-02"],
    summary: summary(),
    ...overrides,
  };
}

function current(overrides: Partial<RegressionCheckInput> = {}): RegressionCheckInput {
  return {
    manifestVersion: "1.0.0",
    caseIds: ["case-01", "case-02"],
    summary: summary(),
    ...overrides,
  };
}

describe("compareToBaseline", () => {
  it("is not a regression when current matches the baseline exactly", () => {
    const result = compareToBaseline(current(), baseline());
    expect(result).toEqual({ regressed: false, reasons: [] });
  });

  it("is not a regression when current improves on the baseline", () => {
    const better = summary({ extractionAccuracy: { total: 10, correct: 10, rate: 1 } });
    const result = compareToBaseline(current({ summary: better }), baseline());
    expect(result.regressed).toBe(false);
  });

  it("is a regression when extraction accuracy drops below the baseline", () => {
    const worse = summary({ extractionAccuracy: { total: 10, correct: 8, rate: 0.8 } });
    const result = compareToBaseline(current({ summary: worse }), baseline());
    expect(result.regressed).toBe(true);
    expect(result.reasons[0]).toMatch(/extraction accuracy regressed/);
  });

  it("is a regression when label-verdict accuracy drops below the baseline", () => {
    const worse = summary({ labelVerdictAccuracy: { total: 10, correct: 5, rate: 0.5 } });
    const result = compareToBaseline(current({ summary: worse }), baseline());
    expect(result.regressed).toBe(true);
    expect(result.reasons.some((r) => r.includes("label-verdict accuracy regressed"))).toBe(true);
  });

  it("is a regression when review-reason accuracy drops below the baseline", () => {
    const worse = summary({ reviewReasonAccuracy: { total: 10, correct: 1, rate: 0.1 } });
    const result = compareToBaseline(current({ summary: worse }), baseline());
    expect(result.regressed).toBe(true);
    expect(result.reasons.some((r) => r.includes("review-reason accuracy regressed"))).toBe(true);
  });

  it("collects every regressed metric, not just the first", () => {
    const worse = summary({
      extractionAccuracy: { total: 10, correct: 1, rate: 0.1 },
      labelVerdictAccuracy: { total: 10, correct: 1, rate: 0.1 },
    });
    const result = compareToBaseline(current({ summary: worse }), baseline());
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("is a regression when the manifest version differs from the baseline", () => {
    const result = compareToBaseline(current({ manifestVersion: "2.0.0" }), baseline());
    expect(result.regressed).toBe(true);
    expect(result.reasons.some((r) => r.includes("manifest version mismatch"))).toBe(true);
  });

  it("is a regression (stale coverage) when current omits a case the baseline was built from", () => {
    const result = compareToBaseline(current({ caseIds: ["case-01"] }), baseline());
    expect(result.regressed).toBe(true);
    expect(result.reasons.some((r) => r.includes("stale coverage"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("case-02"))).toBe(true);
  });

  it("is not a regression when current covers a superset of the baseline's cases", () => {
    const result = compareToBaseline(current({ caseIds: ["case-01", "case-02", "case-03"] }), baseline());
    expect(result.regressed).toBe(false);
  });
});
