import { describe, expect, it } from "vitest";
import type { LabelVerdict, ReviewReason } from "../../src/server/router/types";
import {
  buildBaselineBand,
  buildEvalReportFromRepeat,
  buildPerCaseVerdictSets,
  computeAccuracyBand,
  computeBaselineRepeats,
} from "./baseline-band";
import type { CaseStability, VarianceCaseRun } from "./variance-analysis";
import type { ExtractionCaseScore, ExtractionFieldKey, MeasuredCost, VerdictCaseScore } from "./types";

const EXTRACTION_FIELD_KEYS: readonly ExtractionFieldKey[] = ["brandName", "classType", "abv", "netContents", "governmentWarning"];

/** `correctCount` of the fixed 5 extraction fields score correct, in a
 * fixed order — the same "one builder, several test files" shape
 * `test-support.ts`'s own fixtures use, kept local here since this file's
 * fixture shape (a whole `VarianceCaseRun`) is specific to this suite. */
function extractionScore(caseId: string, correctCount: number): ExtractionCaseScore {
  return {
    caseId,
    category: "clean-match",
    fields: EXTRACTION_FIELD_KEYS.map((field, i) => ({
      field,
      correct: i < correctCount,
      expected: "x",
      actual: i < correctCount ? "x" : "y",
      confidence: 0.9,
      detail: "ok",
    })),
  };
}

function verdictScore(caseId: string, actualLabelVerdict: LabelVerdict, overrides: Partial<VerdictCaseScore> = {}): VerdictCaseScore {
  const expectedLabelVerdict: LabelVerdict = overrides.expectedLabelVerdict ?? "PASS";
  const expectedReviewReason: ReviewReason | null = expectedLabelVerdict === "REVIEW" ? "LOW_IMAGE_QUALITY" : null;
  const actualReviewReason: ReviewReason | null = actualLabelVerdict === "REVIEW" ? "LOW_IMAGE_QUALITY" : null;
  return {
    caseId,
    category: "clean-match",
    expectedLabelVerdict,
    actualLabelVerdict,
    labelVerdictCorrect: actualLabelVerdict === expectedLabelVerdict,
    expectedReviewReason,
    actualReviewReason,
    reviewReasonCorrect: expectedLabelVerdict !== "REVIEW" || expectedReviewReason === actualReviewReason,
    warningChannel: null,
    lowImageQualityTrigger: null,
    fields: [
      { field: "government_warning", expectedVerdict: "MATCH", actualVerdict: "MATCH", correct: true, confidence: 0.95, actualReviewReason: null },
    ],
    ...overrides,
  };
}

function measuredCost(usd: number): MeasuredCost {
  return { model: "test-model", inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, usd };
}

function run(
  caseId: string,
  repeatIndex: number,
  opts: { extractionCorrect: number; verdict: LabelVerdict; haikuUsd?: number; resolverUsd?: number | null } = {
    extractionCorrect: 5,
    verdict: "PASS",
  },
): VarianceCaseRun {
  const cascadeVerdict = verdictScore(caseId, opts.verdict);
  return {
    caseId,
    category: "clean-match",
    extraction: extractionScore(caseId, opts.extractionCorrect),
    routerVerdict: cascadeVerdict,
    cascadeVerdict,
    haikuCost: measuredCost(opts.haikuUsd ?? 0.001),
    resolverCost: opts.resolverUsd != null ? measuredCost(opts.resolverUsd) : null,
    resolverOutcome: opts.resolverUsd != null ? "resolved" : null,
    resolverError: null,
    resolverDurationMs: opts.resolverUsd != null ? 800 : null,
    imageQuality: { legible: "yes", issues: ["none"], confidence: 0.95 },
    beverageType: { value: "spirits", evidence: "spirits", confidence: 0.95 },
    repeatIndex,
  };
}

describe("computeAccuracyBand", () => {
  it("returns min/max/spread over the given rates", () => {
    expect(computeAccuracyBand([0.8125, 0.78125, 0.78125])).toEqual({ min: 0.78125, max: 0.8125, spread: 0.03125 });
  });

  it("collapses to a zero-spread band when every rate is identical", () => {
    expect(computeAccuracyBand([0.9, 0.9])).toEqual({ min: 0.9, max: 0.9, spread: 0 });
  });

  it("throws on an empty input", () => {
    expect(() => computeAccuracyBand([])).toThrow(/no rates to band/);
  });
});

describe("computeBaselineRepeats", () => {
  it("summarizes extraction and cascade-verdict accuracy per repeat, restricted to complete cases", () => {
    const runs: VarianceCaseRun[] = [
      run("case-01", 1, { extractionCorrect: 5, verdict: "PASS" }),
      run("case-02", 1, { extractionCorrect: 4, verdict: "PASS" }),
      run("case-01", 2, { extractionCorrect: 5, verdict: "PASS" }),
      run("case-02", 2, { extractionCorrect: 5, verdict: "FAIL" }),
    ];
    const complete = new Set(["case-01", "case-02"]);
    const repeats = computeBaselineRepeats(runs, complete);
    expect(repeats).toHaveLength(2);
    expect(repeats[0]).toMatchObject({ repeatIndex: 1, extractionAccuracy: { total: 10, correct: 9 } });
    expect(repeats[1]).toMatchObject({ repeatIndex: 2, extractionAccuracy: { total: 10, correct: 10 } });
  });

  it("excludes a case not in completeCaseIds from every repeat's accuracy", () => {
    const runs: VarianceCaseRun[] = [
      run("case-01", 1, { extractionCorrect: 5, verdict: "PASS" }),
      run("case-incomplete", 1, { extractionCorrect: 0, verdict: "FAIL" }),
    ];
    const complete = new Set(["case-01"]);
    const repeats = computeBaselineRepeats(runs, complete);
    expect(repeats).toHaveLength(1);
    expect(repeats[0].extractionAccuracy).toEqual({ total: 5, correct: 5, rate: 1 });
  });

  it("returns one entry per distinct repeatIndex present, sorted", () => {
    const runs: VarianceCaseRun[] = [
      run("case-01", 3, { extractionCorrect: 5, verdict: "PASS" }),
      run("case-01", 1, { extractionCorrect: 5, verdict: "PASS" }),
      run("case-01", 2, { extractionCorrect: 5, verdict: "PASS" }),
    ];
    const repeats = computeBaselineRepeats(runs, new Set(["case-01"]));
    expect(repeats.map((r) => r.repeatIndex)).toEqual([1, 2, 3]);
  });
});

describe("buildPerCaseVerdictSets", () => {
  function stability(caseId: string, verdicts: readonly LabelVerdict[]): CaseStability {
    return {
      caseId,
      runCount: verdicts.length,
      verdicts,
      headlineReasons: verdicts.map(() => null),
      modalVerdict: verdicts[0],
      modalCount: verdicts.length,
      stabilityRate: 1,
      stable: new Set(verdicts).size === 1,
    };
  }

  it("dedupes and orders each case's verdict set PASS, FAIL, REVIEW", () => {
    const perCase = [stability("case-01", ["PASS", "PASS", "PASS"]), stability("case-17", ["REVIEW", "PASS", "REVIEW"])];
    expect(buildPerCaseVerdictSets(perCase)).toEqual({
      "case-01": ["PASS"],
      "case-17": ["PASS", "REVIEW"],
    });
  });

  it("includes every case, even one with only a single verdict", () => {
    const perCase = [stability("case-05", ["FAIL"])];
    expect(buildPerCaseVerdictSets(perCase)).toEqual({ "case-05": ["FAIL"] });
  });
});

describe("buildBaselineBand", () => {
  const baseInput = {
    ticket: "TRO-561",
    establishedAt: "2026-08-13T12:30:00.000Z",
    manifestVersion: "1.0.0",
    manifestContentHash: "abc123",
    goldenSetCommitSha: "deadbeef",
    codeCommitSha: "cafed00d",
    haikuModel: "claude-haiku-4-5",
    sonnetModel: "claude-sonnet-5",
    caseIds: ["case-02", "case-01"],
    perCaseVerdictSets: { "case-01": ["PASS"] as const },
    totalCostUsd: 0.85,
    meanHaikuCallUsd: 0.002,
    meanSonnetCallUsd: null,
  };

  it("bands extraction and cascade-verdict accuracy from the per-repeat rates, K = repeats.length", () => {
    const repeats = [
      { repeatIndex: 1, extractionAccuracy: { total: 10, correct: 10, rate: 1 }, cascadeVerdictAccuracy: { total: 2, correct: 2, rate: 1 } },
      { repeatIndex: 2, extractionAccuracy: { total: 10, correct: 9, rate: 0.9 }, cascadeVerdictAccuracy: { total: 2, correct: 1, rate: 0.5 } },
      { repeatIndex: 3, extractionAccuracy: { total: 10, correct: 9, rate: 0.9 }, cascadeVerdictAccuracy: { total: 2, correct: 2, rate: 1 } },
    ];
    const baseline = buildBaselineBand({ ...baseInput, repeats });
    expect(baseline.k).toBe(3);
    expect(baseline.extractionAccuracyBand).toEqual({ min: 0.9, max: 1, spread: expect.closeTo(0.1, 10) });
    expect(baseline.cascadeVerdictAccuracyBand).toEqual({ min: 0.5, max: 1, spread: 0.5 });
    expect(baseline.caseIds).toEqual(["case-01", "case-02"]);
  });

  it("carries every provenance field through unchanged", () => {
    const repeats = [{ repeatIndex: 1, extractionAccuracy: { total: 1, correct: 1, rate: 1 }, cascadeVerdictAccuracy: { total: 1, correct: 1, rate: 1 } }];
    const baseline = buildBaselineBand({ ...baseInput, repeats });
    expect(baseline.manifestContentHash).toBe("abc123");
    expect(baseline.goldenSetCommitSha).toBe("deadbeef");
    expect(baseline.codeCommitSha).toBe("cafed00d");
    expect(baseline.costUsd).toEqual({ totalUsd: 0.85, meanHaikuCallUsd: 0.002, meanSonnetCallUsd: null });
  });

  it("throws when given zero repeats", () => {
    expect(() => buildBaselineBand({ ...baseInput, repeats: [] })).toThrow(/no complete repeats/);
  });
});

describe("buildEvalReportFromRepeat", () => {
  const runs: VarianceCaseRun[] = [
    run("case-01", 1, { extractionCorrect: 5, verdict: "PASS" }),
    run("case-02", 1, { extractionCorrect: 4, verdict: "PASS" }),
    run("case-01", 2, { extractionCorrect: 3, verdict: "FAIL" }),
    run("case-02", 2, { extractionCorrect: 5, verdict: "PASS" }),
  ];

  it("builds an EvalReport from exactly the named repeat's own runs, dropping repeatIndex", () => {
    const report = buildEvalReportFromRepeat({
      ticket: "TRO-470 / LH-030",
      measuredAt: "2026-08-13T12:30:00.000Z",
      haikuModel: "claude-haiku-4-5",
      sonnetModel: "claude-sonnet-5",
      manifestVersion: "1.0.0",
      manifestContentHash: "abc123",
      requestedFull: true,
      repeatIndex: 1,
      runs,
    });
    expect(report.caseIds).toEqual(["case-01", "case-02"]);
    expect(report.cases).toHaveLength(2);
    expect(report.cases.every((c) => !("repeatIndex" in c))).toBe(true);
    expect(report.summary.extractionAccuracy).toEqual({ total: 10, correct: 9, rate: 0.9 });
    expect(report.failures).toEqual([]);
    expect(report.mode).toBe("live");
  });

  it("uses a different repeat's own data when repeatIndex is 2", () => {
    const report = buildEvalReportFromRepeat({
      ticket: "TRO-470 / LH-030",
      measuredAt: "2026-08-13T12:30:00.000Z",
      haikuModel: "claude-haiku-4-5",
      sonnetModel: "claude-sonnet-5",
      manifestVersion: "1.0.0",
      manifestContentHash: "abc123",
      requestedFull: true,
      repeatIndex: 2,
      runs,
    });
    expect(report.summary.extractionAccuracy).toEqual({ total: 10, correct: 8, rate: 0.8 });
  });

  it("throws when no runs match the requested repeatIndex", () => {
    expect(() =>
      buildEvalReportFromRepeat({
        ticket: "TRO-470 / LH-030",
        measuredAt: "2026-08-13T12:30:00.000Z",
        haikuModel: "claude-haiku-4-5",
        sonnetModel: "claude-sonnet-5",
        manifestVersion: "1.0.0",
        manifestContentHash: "abc123",
        requestedFull: true,
        repeatIndex: 99,
        runs,
      }),
    ).toThrow(/no runs found for repeatIndex 99/);
  });

  it("sums real measured Haiku + resolver cost into totalCostUsd", () => {
    const withResolver: VarianceCaseRun[] = [
      run("case-01", 1, { extractionCorrect: 5, verdict: "REVIEW", haikuUsd: 0.01, resolverUsd: 0.02 }),
    ];
    const report = buildEvalReportFromRepeat({
      ticket: "TRO-470 / LH-030",
      measuredAt: "2026-08-13T12:30:00.000Z",
      haikuModel: "claude-haiku-4-5",
      sonnetModel: "claude-sonnet-5",
      manifestVersion: "1.0.0",
      manifestContentHash: "abc123",
      requestedFull: true,
      repeatIndex: 1,
      runs: withResolver,
    });
    expect(report.totalCostUsd).toBeCloseTo(0.03, 10);
  });
});
