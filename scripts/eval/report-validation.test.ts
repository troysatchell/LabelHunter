import { describe, expect, it } from "vitest";
import { validateEvalBaseline, validateEvalReport, validateVarianceReport } from "./report-validation";

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

// TRO-561: the band baseline's own fixture. K=2, both banded metrics carry
// a real [min, max] range — not the pre-TRO-561 single `summary` block.
const VALID_BASELINE_REPEATS = [
  { repeatIndex: 1, extractionAccuracy: RATE, cascadeVerdictAccuracy: RATE },
  { repeatIndex: 2, extractionAccuracy: RATE, cascadeVerdictAccuracy: RATE },
];
const VALID_ACCURACY_BAND = { min: 0.78125, max: 0.8125, spread: 0.03125 };
const VALID_BASELINE_COST = { totalUsd: 0.95, meanHaikuCallUsd: 0.003, meanSonnetCallUsd: 0.02 };

function validBaseline(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "TRO-561",
    establishedAt: "2026-08-13T12:30:00.000Z",
    k: 2,
    repeats: VALID_BASELINE_REPEATS,
    extractionAccuracyBand: VALID_ACCURACY_BAND,
    cascadeVerdictAccuracyBand: VALID_ACCURACY_BAND,
    perCaseVerdictSets: { "case-01": ["PASS"] },
    manifestVersion: "1.0.0",
    manifestContentHash: "abc123",
    goldenSetCommitSha: "deadbeef",
    caseIds: ["case-01"],
    haikuModel: "claude-haiku-4-5",
    sonnetModel: "claude-sonnet-5",
    codeCommitSha: "cafed00d",
    costUsd: VALID_BASELINE_COST,
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

// TRO-561: validateEvalBaseline now checks the band shape (`k`/`repeats`/
// `extractionAccuracyBand`/`cascadeVerdictAccuracyBand`/`perCaseVerdictSets`/
// `goldenSetCommitSha`/`haikuModel`/`sonnetModel`/`codeCommitSha`/`costUsd`),
// not the old single-point `summary`. These tests replace the pre-TRO-561
// `summary`-shaped ones — the old EvalBaseline schema no longer exists.
describe("validateEvalBaseline", () => {
  it("accepts a well-formed band baseline", () => {
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

  it("rejects a missing or non-positive-integer k", () => {
    const { k: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/"k"/);
    expect(() => validateEvalBaseline(validBaseline({ k: 0 }), "baseline.json")).toThrow(/"k"/);
  });

  it("rejects a repeats entry missing cascadeVerdictAccuracy", () => {
    const badRepeats = [{ repeatIndex: 1, extractionAccuracy: RATE }];
    expect(() => validateEvalBaseline(validBaseline({ repeats: badRepeats }), "baseline.json")).toThrow(/repeats/);
  });

  it("rejects a repeats entry with repeatIndex 0 (1-based, not merely non-negative)", () => {
    const badRepeats = [{ repeatIndex: 0, extractionAccuracy: RATE, cascadeVerdictAccuracy: RATE }];
    expect(() => validateEvalBaseline(validBaseline({ repeats: badRepeats }), "baseline.json")).toThrow(/repeats/);
  });

  it("rejects an EMPTY repeats array — a K-repeat band with zero repeats is not legal (defect-gate: vacuous-empty-quantifier)", () => {
    expect(() => validateEvalBaseline(validBaseline({ repeats: [] }), "baseline.json")).toThrow(/repeats/);
  });

  it("rejects an EMPTY perCaseVerdictSets object (defect-gate: vacuous-empty-quantifier)", () => {
    expect(() => validateEvalBaseline(validBaseline({ perCaseVerdictSets: {} }), "baseline.json")).toThrow(/perCaseVerdictSets/);
  });

  it("rejects a perCaseVerdictSets entry whose own verdict array is empty", () => {
    expect(() => validateEvalBaseline(validBaseline({ perCaseVerdictSets: { "case-01": [] } }), "baseline.json")).toThrow(/perCaseVerdictSets/);
  });

  it("rejects a missing extractionAccuracyBand", () => {
    const { extractionAccuracyBand: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/extractionAccuracyBand/);
  });

  it("rejects a missing cascadeVerdictAccuracyBand (TRO-561's own headline metric)", () => {
    const { cascadeVerdictAccuracyBand: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/cascadeVerdictAccuracyBand/);
  });

  it("rejects an AccuracyBand with an out-of-range min", () => {
    const badBand = { min: 1.5, max: 1.5, spread: 0 };
    expect(() => validateEvalBaseline(validBaseline({ extractionAccuracyBand: badBand }), "baseline.json")).toThrow(/extractionAccuracyBand/);
  });

  it("rejects a missing perCaseVerdictSets", () => {
    const { perCaseVerdictSets: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/perCaseVerdictSets/);
  });

  it("rejects a perCaseVerdictSets entry whose value is not an array of strings", () => {
    expect(() => validateEvalBaseline(validBaseline({ perCaseVerdictSets: { "case-01": "PASS" } }), "baseline.json")).toThrow(/perCaseVerdictSets/);
  });

  it("rejects a missing manifestContentHash (TRO-538 / LH-033)", () => {
    const { manifestContentHash: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/manifestContentHash/);
  });

  it("rejects a missing or empty goldenSetCommitSha (TRO-561: the corpus SHA is a design requirement, not decoration)", () => {
    const { goldenSetCommitSha: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/goldenSetCommitSha/);
    expect(() => validateEvalBaseline(validBaseline({ goldenSetCommitSha: "" }), "baseline.json")).toThrow(/goldenSetCommitSha/);
    expect(() => validateEvalBaseline(validBaseline({ goldenSetCommitSha: "   " }), "baseline.json")).toThrow(/goldenSetCommitSha/);
  });

  it("rejects a missing or empty codeCommitSha", () => {
    const { codeCommitSha: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/codeCommitSha/);
  });

  it("rejects a missing or empty haikuModel/sonnetModel", () => {
    const { haikuModel: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/haikuModel/);
    expect(() => validateEvalBaseline(validBaseline({ sonnetModel: "" }), "baseline.json")).toThrow(/sonnetModel/);
  });

  it("rejects a missing costUsd", () => {
    const { costUsd: _drop, ...rest } = validBaseline();
    expect(() => validateEvalBaseline(rest, "baseline.json")).toThrow(/costUsd/);
  });

  it("accepts costUsd.meanSonnetCallUsd as null (no case escalated during the sweep)", () => {
    const cost = { ...VALID_BASELINE_COST, meanSonnetCallUsd: null };
    expect(() => validateEvalBaseline(validBaseline({ costUsd: cost }), "baseline.json")).not.toThrow();
  });

  it("rejects a costUsd with a non-finite totalUsd", () => {
    const cost = { ...VALID_BASELINE_COST, totalUsd: "0.95" };
    expect(() => validateEvalBaseline(validBaseline({ costUsd: cost }), "baseline.json")).toThrow(/costUsd/);
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
      expect(message).toContain('"k"');
      expect(message).toContain("repeats");
      expect(message).toContain("extractionAccuracyBand");
      expect(message).toContain("cascadeVerdictAccuracyBand");
      expect(message).toContain("goldenSetCommitSha");
      expect(message).toContain("costUsd");
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
// perRun carries exactly RATE's own 0.9 rate, and lowestRate/highestRate
// both equal it too (a single-run spread's low and high are the same
// value) — every field in this fixture agrees with every other, unlike an
// earlier draft that set lowestRate/highestRate to unrelated numbers (a PR
// review finding: a "valid" example fixture should itself be a realistic,
// internally-consistent report, not just individually well-typed fields).
const VALID_ACCURACY_SPREAD = {
  available: true,
  perRun: [{ repeatIndex: 1, labelVerdictAccuracy: RATE }],
  lowestRate: RATE.rate,
  highestRate: RATE.rate,
};
const UNAVAILABLE_ACCURACY_SPREAD = { available: false, perRun: [], lowestRate: null, highestRate: null };
const VALID_CASE_STABILITY = {
  caseId: "case-17-glare-front-label",
  runCount: 5,
  verdicts: ["REVIEW", "PASS", "REVIEW", "REVIEW", "PASS"],
  headlineReasons: ["AMBIGUOUS_BRAND", null, "AMBIGUOUS_BRAND", "AMBIGUOUS_BRAND", null],
  modalVerdict: "REVIEW",
  modalCount: 3,
  stabilityRate: 0.6,
  stable: false,
};
const VALID_VARIANCE_SUMMARY = {
  caseCount: 8,
  nominalRepeats: 5,
  incompleteCaseCount: 0,
  stableCaseRate: RATE,
  accuracySpread: VALID_ACCURACY_SPREAD,
  perCase: [VALID_CASE_STABILITY],
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

  it("rejects a perRun entry with repeatIndex 0 — repeatIndex is 1-based, not merely non-negative", () => {
    const badSummary = {
      ...VALID_VARIANCE_SUMMARY,
      accuracySpread: { ...VALID_ACCURACY_SPREAD, perRun: [{ repeatIndex: 0, labelVerdictAccuracy: RATE }] },
    };
    expect(() => validateVarianceReport(validVarianceReport({ summary: badSummary }), "variance-report.json")).toThrow(/summary/);
  });

  it("accepts an unavailable accuracySpread (no case completed every repeat)", () => {
    const summary = { ...VALID_VARIANCE_SUMMARY, incompleteCaseCount: 8, stableCaseRate: { total: 0, correct: 0, rate: 0 }, accuracySpread: UNAVAILABLE_ACCURACY_SPREAD };
    expect(() => validateVarianceReport(validVarianceReport({ summary }), "variance-report.json")).not.toThrow();
  });

  it("rejects available: true paired with null extrema (an inconsistent accuracySpread)", () => {
    const badSummary = { ...VALID_VARIANCE_SUMMARY, accuracySpread: { ...VALID_ACCURACY_SPREAD, lowestRate: null } };
    expect(() => validateVarianceReport(validVarianceReport({ summary: badSummary }), "variance-report.json")).toThrow(/summary/);
  });

  it("rejects available: false paired with a non-empty perRun (an inconsistent accuracySpread)", () => {
    const badSummary = { ...VALID_VARIANCE_SUMMARY, accuracySpread: { ...UNAVAILABLE_ACCURACY_SPREAD, perRun: VALID_ACCURACY_SPREAD.perRun } };
    expect(() => validateVarianceReport(validVarianceReport({ summary: badSummary }), "variance-report.json")).toThrow(/summary/);
  });

  it("rejects a summary missing incompleteCaseCount", () => {
    const { incompleteCaseCount: _drop, ...summaryRest } = VALID_VARIANCE_SUMMARY;
    expect(() => validateVarianceReport(validVarianceReport({ summary: summaryRest }), "variance-report.json")).toThrow(/summary/);
  });

  it("rejects a summary missing perCase", () => {
    const { perCase: _drop, ...summaryRest } = VALID_VARIANCE_SUMMARY;
    expect(() => validateVarianceReport(validVarianceReport({ summary: summaryRest }), "variance-report.json")).toThrow(/summary/);
  });

  it("rejects a perCase entry missing stabilityRate", () => {
    const { stabilityRate: _drop, ...caseRest } = VALID_CASE_STABILITY;
    const badSummary = { ...VALID_VARIANCE_SUMMARY, perCase: [caseRest] };
    expect(() => validateVarianceReport(validVarianceReport({ summary: badSummary }), "variance-report.json")).toThrow(/summary/);
  });

  it("accepts a perCase entry with a null headlineReasons entry (a PASS/FAIL repeat carries no reason)", () => {
    expect(() => validateVarianceReport(validVarianceReport(), "variance-report.json")).not.toThrow();
    expect(VALID_CASE_STABILITY.headlineReasons).toContain(null);
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

  it("accepts manifestContentHash as a string or as null, and rejects any other type", () => {
    expect(() => validateVarianceReport(validVarianceReport({ manifestContentHash: null }), "variance-report.json")).not.toThrow();
    expect(() => validateVarianceReport(validVarianceReport({ manifestContentHash: "abc123" }), "variance-report.json")).not.toThrow();
    expect(() => validateVarianceReport(validVarianceReport({ manifestContentHash: 7 }), "variance-report.json")).toThrow(/manifestContentHash/);
  });

  // TRO-543 Part 2 (a review finding, triaged): haikuModel/sonnetModel/
  // commitSha/requestedFull used to pass through this validator with no
  // check at all — a caller reading them off the "validated" return value
  // was trusting the cast, not a real check. These cases prove the fix:
  // each field now fails loudly on an absent, empty, or wrongly-typed
  // value. The absent-key case (destructured out, not merely set to a
  // falsy value) proves a field genuinely MISSING from a hand-edited or
  // truncated JSON file is caught the same way — `candidate.haikuModel`
  // reads as `undefined` either way, but only the destructured case proves
  // the check does not depend on the key being present at all.
  it("rejects a missing, empty, or wrongly-typed haikuModel", () => {
    const { haikuModel: _drop, ...rest } = validVarianceReport();
    expect(() => validateVarianceReport(rest, "variance-report.json")).toThrow(/haikuModel/);
    expect(() => validateVarianceReport(validVarianceReport({ haikuModel: "" }), "variance-report.json")).toThrow(/haikuModel/);
    expect(() => validateVarianceReport(validVarianceReport({ haikuModel: 7 }), "variance-report.json")).toThrow(/haikuModel/);
  });

  it("rejects a missing, empty, or wrongly-typed sonnetModel", () => {
    const { sonnetModel: _drop, ...rest } = validVarianceReport();
    expect(() => validateVarianceReport(rest, "variance-report.json")).toThrow(/sonnetModel/);
    expect(() => validateVarianceReport(validVarianceReport({ sonnetModel: "" }), "variance-report.json")).toThrow(/sonnetModel/);
    expect(() => validateVarianceReport(validVarianceReport({ sonnetModel: null }), "variance-report.json")).toThrow(/sonnetModel/);
  });

  it("rejects a missing, empty, or wrongly-typed commitSha", () => {
    const { commitSha: _drop, ...rest } = validVarianceReport();
    expect(() => validateVarianceReport(rest, "variance-report.json")).toThrow(/commitSha/);
    expect(() => validateVarianceReport(validVarianceReport({ commitSha: "" }), "variance-report.json")).toThrow(/commitSha/);
    expect(() => validateVarianceReport(validVarianceReport({ commitSha: 12345 }), "variance-report.json")).toThrow(/commitSha/);
  });

  it("rejects a whitespace-only haikuModel, sonnetModel, or commitSha — non-empty means real content, not just a non-zero length", () => {
    expect(() => validateVarianceReport(validVarianceReport({ haikuModel: "   " }), "variance-report.json")).toThrow(/haikuModel/);
    expect(() => validateVarianceReport(validVarianceReport({ sonnetModel: "\t\n" }), "variance-report.json")).toThrow(/sonnetModel/);
    expect(() => validateVarianceReport(validVarianceReport({ commitSha: "  " }), "variance-report.json")).toThrow(/commitSha/);
  });

  it("rejects a missing or non-boolean requestedFull", () => {
    const { requestedFull: _drop, ...rest } = validVarianceReport();
    expect(() => validateVarianceReport(rest, "variance-report.json")).toThrow(/requestedFull/);
    expect(() => validateVarianceReport(validVarianceReport({ requestedFull: "true" }), "variance-report.json")).toThrow(/requestedFull/);
    expect(() => validateVarianceReport(validVarianceReport({ requestedFull: null }), "variance-report.json")).toThrow(/requestedFull/);
  });

  it("accepts requestedFull as either boolean value", () => {
    expect(() => validateVarianceReport(validVarianceReport({ requestedFull: true }), "variance-report.json")).not.toThrow();
    expect(() => validateVarianceReport(validVarianceReport({ requestedFull: false }), "variance-report.json")).not.toThrow();
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
      expect(message).toContain("haikuModel");
      expect(message).toContain("sonnetModel");
      expect(message).toContain("commitSha");
      expect(message).toContain("requestedFull");
    }
  });
});
