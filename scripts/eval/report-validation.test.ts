import { describe, expect, it } from "vitest";
import { validateEvalBaseline, validateEvalReport, validateVarianceReport } from "./report-validation";

const RATE = { total: 10, correct: 9, rate: 0.9 };
const VALID_WARNING_SEGMENTATION = {
  total: 10,
  clean: { count: 8, rate: 0.8 },
  trueMismatch: { count: 1, rate: 0.1 },
  resolutionSuspect: { count: 1, rate: 0.1 },
  notFound: { count: 0, rate: 0 },
};
const VALID_SUMMARY = {
  extractionAccuracy: RATE,
  extractionAccuracyByField: {},
  labelVerdictAccuracy: RATE,
  fieldVerdictAccuracyByField: {},
  reviewReasonAccuracy: RATE,
  warningSegmentation: VALID_WARNING_SEGMENTATION,
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

  it("rejects a summary missing warningSegmentation (TRO-469 / LH-021)", () => {
    const { warningSegmentation: _drop, ...summaryRest } = VALID_SUMMARY;
    expect(() => validateEvalBaseline(validBaseline({ summary: summaryRest }), "baseline.json")).toThrow(/summary/);
  });

  it("rejects a warningSegmentation whose resolutionSuspect count is negative", () => {
    const badSegmentation = { ...VALID_WARNING_SEGMENTATION, resolutionSuspect: { count: -1, rate: 0 } };
    const badSummary = { ...VALID_SUMMARY, warningSegmentation: badSegmentation };
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

// LH-038 / TRO-543 — the variance runner's own committed artifact.
const VALID_ACCURACY_SPREAD = {
  perRun: [{ repeatIndex: 1, labelVerdictAccuracy: RATE }],
  lowestRate: 0.8,
  highestRate: 0.9,
};
const VALID_VARIANCE_SUMMARY = {
  caseCount: 8,
  nominalRepeats: 5,
  stableCaseRate: RATE,
  accuracySpread: VALID_ACCURACY_SPREAD,
};

function validVarianceReport(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "TRO-543 / LH-038",
    measuredAt: "2026-08-12T00:00:00.000Z",
    mode: "live",
    haikuModel: "claude-haiku-4-5",
    sonnetModel: "claude-sonnet-5",
    manifestVersion: "1.0.0",
    manifestContentHash: null,
    commitSha: "deadbeef",
    requestedFull: false,
    caseIds: ["case-01"],
    repeats: 5,
    summary: VALID_VARIANCE_SUMMARY,
    totalCostUsd: 0.19,
    runs: [],
    failures: [],
    ...overrides,
  };
}

describe("validateVarianceReport", () => {
  it("accepts a well-formed report", () => {
    expect(() => validateVarianceReport(validVarianceReport(), "variance-report.json")).not.toThrow();
  });

  it("accepts manifestContentHash as a real string too (once TRO-538/LH-033 populates it)", () => {
    expect(() =>
      validateVarianceReport(validVarianceReport({ manifestContentHash: "abc123" }), "variance-report.json"),
    ).not.toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => validateVarianceReport(null, "variance-report.json")).toThrow(/does not contain a JSON object/);
    expect(() => validateVarianceReport([], "variance-report.json")).toThrow(/does not contain a JSON object/);
  });

  it("rejects a missing measuredAt, naming the file and the field", () => {
    const { measuredAt: _drop, ...rest } = validVarianceReport();
    expect(() => validateVarianceReport(rest, "scripts/eval/results/variance-report.json")).toThrow(
      /scripts\/eval\/results\/variance-report\.json/,
    );
    expect(() => validateVarianceReport(rest, "variance-report.json")).toThrow(/measuredAt/);
  });

  it("rejects a non-positive-integer repeats", () => {
    expect(() => validateVarianceReport(validVarianceReport({ repeats: 0 }), "variance-report.json")).toThrow(/repeats/);
    expect(() => validateVarianceReport(validVarianceReport({ repeats: 2.5 }), "variance-report.json")).toThrow(/repeats/);
    expect(() => validateVarianceReport(validVarianceReport({ repeats: "5" }), "variance-report.json")).toThrow(/repeats/);
  });

  it("rejects a non-array caseIds", () => {
    expect(() => validateVarianceReport(validVarianceReport({ caseIds: "case-01" }), "variance-report.json")).toThrow(/caseIds/);
  });

  it("rejects a summary missing stableCaseRate", () => {
    const { stableCaseRate: _drop, ...summaryRest } = VALID_VARIANCE_SUMMARY;
    expect(() => validateVarianceReport(validVarianceReport({ summary: summaryRest }), "variance-report.json")).toThrow(/summary/);
  });

  it("rejects a summary whose accuracySpread is missing perRun", () => {
    const { perRun: _drop, ...spreadRest } = VALID_ACCURACY_SPREAD;
    const badSummary = { ...VALID_VARIANCE_SUMMARY, accuracySpread: spreadRest };
    expect(() => validateVarianceReport(validVarianceReport({ summary: badSummary }), "variance-report.json")).toThrow(/summary/);
  });

  it("rejects an accuracySpread.perRun entry with an out-of-range rate", () => {
    const badSummary = {
      ...VALID_VARIANCE_SUMMARY,
      accuracySpread: { ...VALID_ACCURACY_SPREAD, perRun: [{ repeatIndex: 1, labelVerdictAccuracy: { total: 5, correct: 9, rate: 1.8 } }] },
    };
    expect(() => validateVarianceReport(validVarianceReport({ summary: badSummary }), "variance-report.json")).toThrow(/summary/);
  });

  it("rejects a report missing runs", () => {
    const { runs: _drop, ...rest } = validVarianceReport();
    expect(() => validateVarianceReport(rest, "variance-report.json")).toThrow(/runs/);
  });

  it("rejects a report missing failures", () => {
    const { failures: _drop, ...rest } = validVarianceReport();
    expect(() => validateVarianceReport(rest, "variance-report.json")).toThrow(/failures/);
  });

  it("rejects a non-numeric totalCostUsd", () => {
    expect(() => validateVarianceReport(validVarianceReport({ totalCostUsd: "0.19" }), "variance-report.json")).toThrow(/totalCostUsd/);
  });

  it("collects multiple problems in one error rather than stopping at the first", () => {
    try {
      validateVarianceReport({}, "variance-report.json");
      expect.unreachable("expected validateVarianceReport to throw on an empty object");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("measuredAt");
      expect(message).toContain("repeats");
      expect(message).toContain("caseIds");
      expect(message).toContain("summary");
      expect(message).toContain("runs");
      expect(message).toContain("failures");
      expect(message).toContain("totalCostUsd");
    }
  });
});
