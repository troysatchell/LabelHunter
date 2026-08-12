import { describe, expect, it } from "vitest";
import { validateEvalBaseline, validateEvalReport } from "./report-validation";

const RATE = { total: 10, correct: 9, rate: 0.9 };
const VALID_SUMMARY = {
  extractionAccuracy: RATE,
  extractionAccuracyByField: {},
  labelVerdictAccuracy: RATE,
  fieldVerdictAccuracyByField: {},
  reviewReasonAccuracy: RATE,
};

function validBaseline(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "TRO-470",
    establishedAt: "2026-08-12T00:00:00.000Z",
    manifestVersion: "1.0.0",
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
    const { labelVerdictAccuracy: _drop, ...summaryRest } = VALID_SUMMARY;
    expect(() => validateEvalBaseline(validBaseline({ summary: summaryRest }), "baseline.json")).toThrow(/summary/);
  });

  it("rejects an AccuracySummary with an out-of-range rate", () => {
    const badSummary = { ...VALID_SUMMARY, extractionAccuracy: { total: 10, correct: 9, rate: 1.5 } };
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
