import { describe, expect, it } from "vitest";
import { validateEvalBaseline, validateEvalReport } from "./report-validation";

const RATE = { total: 10, correct: 9, rate: 0.9 };
const VALID_WARNING_SEGMENTATION = {
  total: 10,
  clean: { count: 8, rate: 0.8 },
  trueMismatch: { count: 1, rate: 0.1 },
  resolutionSuspect: { count: 1, rate: 0.1 },
  notFound: { count: 0, rate: 0 },
  singleChannelPass: { count: 2, rate: 0.2 },
};
const VALID_RELIABILITY_DIAGRAM = Array.from({ length: 10 }, (_, decile) => ({ decile, n: 0, correct: 0, rate: 0 }));
const VALID_SUMMARY = {
  extractionAccuracy: RATE,
  extractionAccuracyByField: {},
  routerVerdictAccuracy: RATE,
  fieldVerdictAccuracyByField: {},
  reviewReasonAccuracy: RATE,
  warningSegmentation: VALID_WARNING_SEGMENTATION,
  cascadeVerdictAccuracy: RATE,
  extractionReliabilityDiagram: VALID_RELIABILITY_DIAGRAM,
};

function validBaseline(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "TRO-470",
    establishedAt: "2026-08-12T00:00:00.000Z",
    manifestVersion: "1.0.0",
    manifestContentHash: "abc123",
    caseIds: ["case-01"],
    summary: VALID_SUMMARY,
    ...overrides,
  };
}

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "TRO-470",
    measuredAt: "2026-08-12T00:00:00.000Z",
    mode: "live",
    manifestVersion: "1.0.0",
    manifestContentHash: "abc123",
    caseIds: ["case-01"],
    summary: VALID_SUMMARY,
    cases: [],
    totalCostUsd: 0.1,
    failures: [],
    ...overrides,
  };
}

describe("validateEvalBaseline", () => {
  it("accepts a well-formed baseline", () => {
    expect(() => validateEvalBaseline(validBaseline(), "baseline.json")).not.toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => validateEvalBaseline(null, "baseline.json")).toThrow(/does not contain a JSON object/);
    expect(() => validateEvalBaseline("a string", "baseline.json")).toThrow(/does not contain a JSON object/);
  });

  it("rejects a missing manifestVersion, naming the file and the field", () => {
    const { manifestVersion: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "scripts/eval/baseline.json")).toThrow(/scripts\/eval\/baseline\.json/);
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/manifestVersion/);
  });

  it("rejects a non-array caseIds", () => {
    expect(() => validateEvalBaseline(validBaseline({ caseIds: "case-01" }), "baseline.json")).toThrow(/caseIds/);
  });

  it("rejects a summary missing a required AccuracySummary", () => {
    const { routerVerdictAccuracy: _drop, ...summaryRest } = VALID_SUMMARY;
    expect(() => validateEvalBaseline(validBaseline({ summary: summaryRest }), "baseline.json")).toThrow(/summary/);
  });

  it("rejects a summary missing cascadeVerdictAccuracy (TRO-538 / LH-033)", () => {
    const { cascadeVerdictAccuracy: _drop, ...summaryRest } = VALID_SUMMARY;
    expect(() => validateEvalBaseline(validBaseline({ summary: summaryRest }), "baseline.json")).toThrow(/summary/);
  });

  it("rejects a summary missing extractionReliabilityDiagram (TRO-538 / LH-033)", () => {
    const { extractionReliabilityDiagram: _drop, ...summaryRest } = VALID_SUMMARY;
    expect(() => validateEvalBaseline(validBaseline({ summary: summaryRest }), "baseline.json")).toThrow(/summary/);
  });

  it("rejects a missing manifestContentHash (TRO-538 / LH-033)", () => {
    const { manifestContentHash: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/manifestContentHash/);
  });

  it("rejects an AccuracySummary with an out-of-range rate", () => {
    const badSummary = { ...VALID_SUMMARY, extractionAccuracy: { total: 10, correct: 9, rate: 1.5 } };
    expect(() => validateEvalBaseline(validBaseline({ summary: badSummary }), "baseline.json")).toThrow(/summary/);
  });

  it("rejects a summary missing warningSegmentation (TRO-469 / LH-021)", () => {
    const { warningSegmentation: _drop, ...summaryRest } = VALID_SUMMARY;
    expect(() => validateEvalBaseline(validBaseline({ summary: summaryRest }), "baseline.json")).toThrow(/summary/);
  });

  it("rejects a warningSegmentation whose resolutionSuspect count is negative", () => {
    const badSegmentation = { ...VALID_WARNING_SEGMENTATION, resolutionSuspect: { count: -1, rate: 0 } };
    const badSummary = { ...VALID_SUMMARY, warningSegmentation: badSegmentation };
    expect(() => validateEvalBaseline(validBaseline({ summary: badSummary }), "baseline.json")).toThrow(/summary/);
  });

  it("rejects a warningSegmentation missing singleChannelPass (TRO-535 / LH-030b)", () => {
    const { singleChannelPass: _drop, ...segmentationRest } = VALID_WARNING_SEGMENTATION;
    const badSummary = { ...VALID_SUMMARY, warningSegmentation: segmentationRest };
    expect(() => validateEvalBaseline(validBaseline({ summary: badSummary }), "baseline.json")).toThrow(/summary/);
  });

  it("collects multiple problems in one error rather than stopping at the first", () => {
    try {
      validateEvalBaseline({}, "baseline.json");
      expect.unreachable("expected validateEvalBaseline to throw on an empty object");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("manifestVersion");
      expect(message).toContain("caseIds");
      expect(message).toContain("establishedAt");
      expect(message).toContain("summary");
    }
  });
});

describe("validateEvalReport", () => {
  it("accepts a well-formed report", () => {
    expect(() => validateEvalReport(validReport(), "eval-report.json")).not.toThrow();
  });

  it("rejects a report missing failures", () => {
    const { failures: _drop, ...rest } = validReport();
    expect(() => validateEvalReport(rest, "eval-report.json")).toThrow(/failures/);
  });

  it("rejects a non-object", () => {
    expect(() => validateEvalReport([], "eval-report.json")).toThrow(/does not contain a JSON object/);
  });
});
