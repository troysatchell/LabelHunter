import { describe, expect, it } from "vitest";
import type { LabelVerdict, ReviewReason } from "../../src/server/router/types";
import type { MeasuredCost, VerdictCaseScore } from "./types";
import {
  buildVarianceReport,
  computeAccuracySpread,
  computeCaseStability,
  computeCorpusStability,
  findCompleteCaseIds,
  findMissingCaseIds,
  isNarrowerReport,
  type RepeatedVerdict,
  type VarianceCaseFailure,
  type VarianceCaseRun,
} from "./variance-analysis";

/**
 * A `VerdictCaseScore` fixture shaped exactly like the real case-17
 * finding this ticket measures: category "glare", expects REVIEW /
 * LOW_IMAGE_QUALITY, and — when it actually escalates — comes back
 * REVIEW / AMBIGUOUS_BRAND (the real headline reason five committed runs
 * produced; see this ticket's `CHANGES.md` entry). Includes a
 * `government_warning` field row because `computeAccuracySpread` reuses
 * `summarizeVerdict`, which reuses `segmentWarningCheckOutcomes`, which
 * throws on a case missing one (`warning-segmentation.ts`'s
 * `findWarningOutcome` — the same requirement `summary.test.ts`'s own
 * `verdictCase` fixture documents).
 */
function verdictScore(caseId: string, actualLabelVerdict: LabelVerdict, overrides: Partial<VerdictCaseScore> = {}): VerdictCaseScore {
  // Resolve expectedLabelVerdict FIRST (honoring a caller override) so
  // every other derived field below — labelVerdictCorrect above all —
  // is computed against the value this fixture will actually carry, not
  // a hardcoded "REVIEW" assumption a caller's override would silently
  // invalidate.
  const expectedLabelVerdict: LabelVerdict = overrides.expectedLabelVerdict ?? "REVIEW";
  const expectedReviewReason: ReviewReason | null = expectedLabelVerdict === "REVIEW" ? "LOW_IMAGE_QUALITY" : null;
  const actualReviewReason: ReviewReason | null = actualLabelVerdict === "REVIEW" ? "AMBIGUOUS_BRAND" : null;
  return {
    caseId,
    category: "glare",
    expectedLabelVerdict,
    actualLabelVerdict,
    labelVerdictCorrect: actualLabelVerdict === expectedLabelVerdict,
    expectedReviewReason,
    actualReviewReason,
    reviewReasonCorrect: expectedLabelVerdict !== "REVIEW" || expectedReviewReason === actualReviewReason,
    warningChannel: null,
    fields: [
      { field: "government_warning", expectedVerdict: "MATCH", actualVerdict: "MATCH", correct: true, confidence: 0.95, actualReviewReason: null },
    ],
    ...overrides,
  };
}

function repeat(repeatIndex: number, actualLabelVerdict: LabelVerdict, caseId = "case-x"): RepeatedVerdict {
  return { repeatIndex, verdict: verdictScore(caseId, actualLabelVerdict) };
}

describe("computeCaseStability", () => {
  it("is stable when every repeat returns the identical verdict", () => {
    const repeats = [repeat(1, "REVIEW"), repeat(2, "REVIEW"), repeat(3, "REVIEW")];
    const result = computeCaseStability("case-a", repeats);
    expect(result).toMatchObject({
      caseId: "case-a",
      runCount: 3,
      modalVerdict: "REVIEW",
      modalCount: 3,
      stabilityRate: 1,
      stable: true,
    });
  });

  it("reproduces the real case-17 finding: 3 REVIEW / 2 PASS across 5 repeats is unstable, modal REVIEW", () => {
    // Same chronological order as the five committed runs this ticket's
    // CHANGES.md entry reports: REVIEW, PASS, REVIEW, REVIEW, PASS.
    const repeats = [
      repeat(1, "REVIEW", "case-17-glare-front-label"),
      repeat(2, "PASS", "case-17-glare-front-label"),
      repeat(3, "REVIEW", "case-17-glare-front-label"),
      repeat(4, "REVIEW", "case-17-glare-front-label"),
      repeat(5, "PASS", "case-17-glare-front-label"),
    ];
    const result = computeCaseStability("case-17-glare-front-label", repeats);
    expect(result.runCount).toBe(5);
    expect(result.modalVerdict).toBe("REVIEW");
    expect(result.modalCount).toBe(3);
    expect(result.stabilityRate).toBe(0.6);
    expect(result.stable).toBe(false);
    expect(result.verdicts).toEqual(["REVIEW", "PASS", "REVIEW", "REVIEW", "PASS"]);
    // PASS repeats carry no headline reason; REVIEW repeats carry the real
    // one the fixture models (AMBIGUOUS_BRAND) — paired per-repeat, not
    // shuffled.
    expect(result.headlineReasons).toEqual(["AMBIGUOUS_BRAND", null, "AMBIGUOUS_BRAND", "AMBIGUOUS_BRAND", null]);
  });

  it("orders verdicts and headlineReasons by repeatIndex, not input order", () => {
    const repeats = [repeat(3, "FAIL"), repeat(1, "PASS"), repeat(2, "REVIEW")];
    const result = computeCaseStability("case-b", repeats);
    expect(result.verdicts).toEqual(["PASS", "REVIEW", "FAIL"]);
  });

  it("breaks a tie deterministically: PASS beats REVIEW at equal counts", () => {
    const repeats = [repeat(1, "PASS"), repeat(2, "REVIEW"), repeat(3, "PASS"), repeat(4, "REVIEW")];
    const result = computeCaseStability("case-c", repeats);
    expect(result.modalVerdict).toBe("PASS");
    expect(result.modalCount).toBe(2);
    expect(result.stable).toBe(false);
  });

  it("breaks a tie deterministically: FAIL beats REVIEW at equal counts", () => {
    const repeats = [repeat(1, "FAIL"), repeat(2, "REVIEW")];
    const result = computeCaseStability("case-d", repeats);
    expect(result.modalVerdict).toBe("FAIL");
    expect(result.modalCount).toBe(1);
  });

  it("breaks a three-way tie by the fixed PASS/FAIL/REVIEW order", () => {
    const repeats = [repeat(1, "REVIEW"), repeat(2, "FAIL"), repeat(3, "PASS")];
    const result = computeCaseStability("case-e", repeats);
    expect(result.modalVerdict).toBe("PASS");
    expect(result.modalCount).toBe(1);
    expect(result.stabilityRate).toBeCloseTo(1 / 3);
  });

  it("throws on zero repeats", () => {
    expect(() => computeCaseStability("case-f", [])).toThrow(/zero repeats/);
  });

  it("throws when two repeats share a repeatIndex", () => {
    const repeats = [repeat(1, "PASS"), repeat(1, "REVIEW")];
    expect(() => computeCaseStability("case-g", repeats)).toThrow(/sharing repeatIndex 1/);
  });

  it("a single repeat is trivially stable (runCount 1, stabilityRate 1)", () => {
    const result = computeCaseStability("case-h", [repeat(1, "PASS")]);
    expect(result).toMatchObject({ runCount: 1, modalCount: 1, stabilityRate: 1, stable: true });
  });
});

describe("findCompleteCaseIds", () => {
  it("includes only cases whose completed-repeat count equals the nominal K", () => {
    const byCase = new Map<string, RepeatedVerdict[]>([
      ["case-full", [repeat(1, "PASS", "case-full"), repeat(2, "PASS", "case-full")]],
      ["case-partial", [repeat(1, "PASS", "case-partial")]],
    ]);
    expect(findCompleteCaseIds(byCase, 2)).toEqual(new Set(["case-full"]));
  });

  it("returns an empty set when no case completed the nominal K", () => {
    const byCase = new Map<string, RepeatedVerdict[]>([["case-partial", [repeat(1, "PASS", "case-partial")]]]);
    expect(findCompleteCaseIds(byCase, 5).size).toBe(0);
  });

  it("returns every case when all completed the nominal K", () => {
    const byCase = new Map<string, RepeatedVerdict[]>([
      ["a", [repeat(1, "PASS", "a")]],
      ["b", [repeat(1, "PASS", "b")]],
    ]);
    expect(findCompleteCaseIds(byCase, 1)).toEqual(new Set(["a", "b"]));
  });
});

// PR review finding (TRO-543): stability and accuracy spread must be scored
// over a SHARED complete-case population, never a case-by-case or
// run-by-run population that silently varies in size — otherwise a
// headline number can look more conclusive than the (possibly partial)
// evidence behind it, or compare mismatched populations across runs. This
// ticket's own retrospective step already applies the identical discipline
// by hand: "restrict to the 29 cases present in every run."
describe("computeCorpusStability", () => {
  it("computes the '28 of 29'-style corpus rate, scored over completeCaseIds: mostly-stable cases plus one unstable case", () => {
    const byCase = new Map<string, RepeatedVerdict[]>([
      ["case-01", [repeat(1, "PASS", "case-01"), repeat(2, "PASS", "case-01")]],
      ["case-02", [repeat(1, "FAIL", "case-02"), repeat(2, "FAIL", "case-02")]],
      ["case-03", [repeat(1, "REVIEW", "case-03"), repeat(2, "REVIEW", "case-03")]],
      ["case-17", [repeat(1, "REVIEW", "case-17"), repeat(2, "PASS", "case-17")]],
    ]);
    const completeCaseIds = new Set(["case-01", "case-02", "case-03", "case-17"]);
    const result = computeCorpusStability(byCase, completeCaseIds);
    expect(result.stableCaseRate).toEqual({ total: 4, correct: 3, rate: 0.75 });
    expect(result.perCase.find((c) => c.caseId === "case-17")!.stable).toBe(false);
  });

  it("excludes a case from stableCaseRate when it is not in completeCaseIds, even though perCase still carries it in full", () => {
    const byCase = new Map<string, RepeatedVerdict[]>([
      ["case-01", [repeat(1, "PASS", "case-01"), repeat(2, "PASS", "case-01")]],
      ["case-17", [repeat(1, "REVIEW", "case-17")]], // only 1 of 2 requested repeats completed
    ]);
    const completeCaseIds = new Set(["case-01"]); // case-17 deliberately excluded: incomplete
    const result = computeCorpusStability(byCase, completeCaseIds);
    expect(result.stableCaseRate).toEqual({ total: 1, correct: 1, rate: 1 });
    expect(result.perCase).toHaveLength(2); // nothing dropped from perCase
    expect(result.perCase.find((c) => c.caseId === "case-17")).toMatchObject({ runCount: 1, stable: true });
  });

  it("sorts perCase by caseId regardless of Map insertion order, independent of completeCaseIds", () => {
    const byCase = new Map<string, RepeatedVerdict[]>([
      ["case-z", [repeat(1, "PASS", "case-z")]],
      ["case-a", [repeat(1, "PASS", "case-a")]],
      ["case-m", [repeat(1, "PASS", "case-m")]],
    ]);
    const result = computeCorpusStability(byCase, new Set());
    expect(result.perCase.map((c) => c.caseId)).toEqual(["case-a", "case-m", "case-z"]);
  });

  it("returns an empty, zeroed summary for an empty map", () => {
    const result = computeCorpusStability(new Map(), new Set());
    expect(result.perCase).toEqual([]);
    expect(result.stableCaseRate).toEqual({ total: 0, correct: 0, rate: 0 });
  });
});

describe("computeAccuracySpread", () => {
  it("computes lowest/highest label-verdict accuracy across runs, restricted to completeCaseIds, reusing summarizeVerdict", () => {
    const completeCaseIds = new Set(["a", "b", "c"]);
    const byRepeat = new Map<number, VerdictCaseScore[]>([
      [1, [verdictScore("a", "REVIEW"), verdictScore("b", "PASS"), verdictScore("c", "PASS")]], // 1/3 correct
      [2, [verdictScore("a", "REVIEW"), verdictScore("b", "REVIEW"), verdictScore("c", "PASS")]], // 2/3 correct
    ]);
    const result = computeAccuracySpread(byRepeat, completeCaseIds);
    expect(result.available).toBe(true);
    expect(result.perRun).toEqual([
      { repeatIndex: 1, labelVerdictAccuracy: { total: 3, correct: 1, rate: 1 / 3 } },
      { repeatIndex: 2, labelVerdictAccuracy: { total: 3, correct: 2, rate: 2 / 3 } },
    ]);
    expect(result.lowestRate).toBeCloseTo(1 / 3);
    expect(result.highestRate).toBeCloseTo(2 / 3);
  });

  it("excludes a case from every run's accuracy when it is not in completeCaseIds, even when present in the raw byRepeat data", () => {
    const completeCaseIds = new Set(["a"]); // "d" deliberately excluded (an incomplete case)
    const byRepeat = new Map<number, VerdictCaseScore[]>([[1, [verdictScore("a", "REVIEW"), verdictScore("d", "FAIL")]]]);
    const result = computeAccuracySpread(byRepeat, completeCaseIds);
    expect(result.perRun).toEqual([{ repeatIndex: 1, labelVerdictAccuracy: { total: 1, correct: 1, rate: 1 } }]);
  });

  it("is unavailable when completeCaseIds is empty — no shared population to compare runs over, never a fabricated 0", () => {
    const byRepeat = new Map<number, VerdictCaseScore[]>([[1, [verdictScore("a", "REVIEW")]]]);
    const result = computeAccuracySpread(byRepeat, new Set());
    expect(result).toEqual({ available: false, perRun: [], lowestRate: null, highestRate: null });
  });

  it("is unavailable, never Infinity/-Infinity, when completeCaseIds is non-empty but byRepeat has no matching data (a mismatched-argument call buildVarianceReport itself never makes, but this exported pure function must still guard against)", () => {
    const result = computeAccuracySpread(new Map(), new Set(["a"]));
    expect(result).toEqual({ available: false, perRun: [], lowestRate: null, highestRate: null });
  });

  it("reproduces the two-run 62.1% / 65.5% shape this ticket's CHANGES.md already reports by hand", () => {
    // 29 cases, all expecting PASS for simplicity — 18 correct in run 1,
    // 19 correct in run 2 (one case flips, exactly the case-17 shape).
    const allIds = new Set(Array.from({ length: 29 }, (_, i) => `case-${i}`));
    function runOf(correctCount: number): VerdictCaseScore[] {
      return Array.from({ length: 29 }, (_, i) => verdictScore(`case-${i}`, i < correctCount ? "PASS" : "FAIL", { expectedLabelVerdict: "PASS" }));
    }
    const byRepeat = new Map<number, VerdictCaseScore[]>([
      [1, runOf(18)],
      [2, runOf(19)],
    ]);
    const result = computeAccuracySpread(byRepeat, allIds);
    expect(result.lowestRate).toBeCloseTo(18 / 29);
    expect(result.highestRate).toBeCloseTo(19 / 29);
  });

  it("a single run has lowest === highest", () => {
    const byRepeat = new Map<number, VerdictCaseScore[]>([[1, [verdictScore("a", "REVIEW")]]]);
    const result = computeAccuracySpread(byRepeat, new Set(["a"]));
    expect(result.lowestRate).toBe(result.highestRate);
  });

  it("sorts perRun by repeatIndex regardless of Map insertion order", () => {
    const byRepeat = new Map<number, VerdictCaseScore[]>([
      [3, [verdictScore("a", "REVIEW")]],
      [1, [verdictScore("a", "REVIEW")]],
      [2, [verdictScore("a", "REVIEW")]],
    ]);
    const result = computeAccuracySpread(byRepeat, new Set(["a"]));
    expect(result.perRun.map((r) => r.repeatIndex)).toEqual([1, 2, 3]);
  });
});

function cost(usd: number): MeasuredCost {
  return { model: "test-model", inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, usd };
}

function caseRun(
  caseId: string,
  repeatIndex: number,
  actualLabelVerdict: LabelVerdict,
  opts: { haikuUsd?: number; resolverUsd?: number | null } = {},
): VarianceCaseRun {
  const resolverUsd = opts.resolverUsd ?? null;
  // routerVerdict and cascadeVerdict both carry the SAME score here
  // (TRO-538 / LH-033 merge-integration fix, TRO-543 predates the split):
  // these fixtures test verdict STABILITY across repeats, not the
  // router-vs-cascade distinction, so one shared verdictScore() per run
  // is the least surprising fixture shape.
  const verdict = verdictScore(caseId, actualLabelVerdict);
  return {
    caseId,
    category: "glare",
    repeatIndex,
    extraction: { caseId, category: "glare", fields: [] },
    routerVerdict: verdict,
    cascadeVerdict: verdict,
    haikuCost: cost(opts.haikuUsd ?? 0.0046),
    resolverCost: resolverUsd !== null ? cost(resolverUsd) : null,
    resolverOutcome: resolverUsd !== null ? "resolved" : null,
    resolverError: null,
    resolverDurationMs: resolverUsd !== null ? 1200 : null,
    imageQuality: { legible: "yes", issues: [], confidence: 0.95 },
    beverageType: { value: "wine", evidence: "wine", confidence: 0.95 },
  };
}

describe("buildVarianceReport", () => {
  const baseInput = {
    ticket: "TRO-543 / LH-038",
    measuredAt: "2026-08-12T00:00:00.000Z",
    haikuModel: "claude-haiku-4-5",
    sonnetModel: "claude-sonnet-5",
    manifestVersion: "1.0.0",
    manifestContentHash: null,
    commitSha: "deadbeef",
    requestedFull: false,
  };

  it("assembles a full report: sums real measured cost and computes stability + spread together, over a complete case set", () => {
    const runs: VarianceCaseRun[] = [
      caseRun("case-01", 1, "PASS", { haikuUsd: 0.004 }),
      caseRun("case-01", 2, "PASS", { haikuUsd: 0.005 }),
      caseRun("case-17", 1, "REVIEW", { haikuUsd: 0.004, resolverUsd: 0.011 }),
      caseRun("case-17", 2, "PASS", { haikuUsd: 0.004 }),
    ];
    const report = buildVarianceReport({ ...baseInput, caseIds: ["case-17", "case-01"], repeats: 2, runs, failures: [] });

    expect(report.mode).toBe("live");
    expect(report.ticket).toBe("TRO-543 / LH-038");
    expect(report.commitSha).toBe("deadbeef");
    expect(report.manifestContentHash).toBeNull();
    expect(report.caseIds).toEqual(["case-01", "case-17"]); // sorted, not input order
    expect(report.repeats).toBe(2);
    expect(report.summary.caseCount).toBe(2);
    expect(report.summary.nominalRepeats).toBe(2);
    // Both cases completed both repeats -- nothing excluded.
    expect(report.summary.incompleteCaseCount).toBe(0);
    expect(report.summary.stableCaseRate).toEqual({ total: 2, correct: 1, rate: 0.5 });
    expect(report.summary.accuracySpread.available).toBe(true);
    // The full per-case detail (Do item 4's own requirement) is present in
    // the report, not just folded into the aggregate rate.
    expect(report.summary.perCase.map((c) => c.caseId)).toEqual(["case-01", "case-17"]);
    // case-17's two repeats are REVIEW then PASS -- a 1-1 tie, broken by
    // the fixed PASS/FAIL/REVIEW order, so PASS wins the modal slot.
    expect(report.summary.perCase.find((c) => c.caseId === "case-17")).toMatchObject({ modalVerdict: "PASS", modalCount: 1, stable: false });
    expect(report.totalCostUsd).toBeCloseTo(0.004 + 0.005 + 0.004 + 0.011 + 0.004);
    expect(report.runs).toHaveLength(4);
    expect(report.failures).toEqual([]);
  });

  it("excludes a case from stableCaseRate and accuracySpread when a sibling repeat failed (the ragged-grid case), without dropping it from the report", () => {
    const runs: VarianceCaseRun[] = [caseRun("case-17", 1, "REVIEW")];
    const failures: VarianceCaseFailure[] = [{ caseId: "case-17", repeatIndex: 2, error: "transient API error" }];
    const report = buildVarianceReport({ ...baseInput, caseIds: ["case-17"], repeats: 2, runs, failures });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toEqual({ caseId: "case-17", repeatIndex: 2, error: "transient API error" });
    // case-17 completed only 1 of its 2 requested repeats -- it is NOT a
    // member of the complete-case set, so PR review's fix keeps it out of
    // the headline rate/spread entirely (never blended in on partial
    // evidence), while still recording it, in full, in perCase.
    expect(report.summary.incompleteCaseCount).toBe(1);
    expect(report.summary.stableCaseRate).toEqual({ total: 0, correct: 0, rate: 0 });
    expect(report.summary.accuracySpread).toEqual({ available: false, perRun: [], lowestRate: null, highestRate: null });
  });

  it("mixed sweep: a complete case counts toward stableCaseRate/spread, an incomplete sibling does not", () => {
    const runs: VarianceCaseRun[] = [
      caseRun("case-01", 1, "PASS"),
      caseRun("case-01", 2, "PASS"), // complete: 2/2
      caseRun("case-17", 1, "REVIEW"), // incomplete: 1/2
    ];
    const failures: VarianceCaseFailure[] = [{ caseId: "case-17", repeatIndex: 2, error: "transient API error" }];
    const report = buildVarianceReport({ ...baseInput, caseIds: ["case-01", "case-17"], repeats: 2, runs, failures });

    expect(report.summary.caseCount).toBe(2); // both cases still counted as attempted
    expect(report.summary.incompleteCaseCount).toBe(1); // only case-17
    expect(report.summary.stableCaseRate).toEqual({ total: 1, correct: 1, rate: 1 }); // case-01 only
    expect(report.summary.accuracySpread.available).toBe(true); // case-01 alone is a non-empty complete set
    expect(report.summary.accuracySpread.perRun).toEqual([
      { repeatIndex: 1, labelVerdictAccuracy: { total: 1, correct: 0, rate: 0 } }, // case-01 expects REVIEW by default, got PASS
      { repeatIndex: 2, labelVerdictAccuracy: { total: 1, correct: 0, rate: 0 } },
    ]);
    // case-17 itself is still fully recorded, in full, just outside the
    // headline rate -- nothing about a case's own data is dropped for
    // being incomplete.
    expect(report.summary.perCase.map((c) => c.caseId)).toEqual(["case-01", "case-17"]);
    expect(report.summary.perCase.find((c) => c.caseId === "case-17")).toMatchObject({ runCount: 1, verdicts: ["REVIEW"], stable: true });
  });

  it("returns a zeroed, unavailable summary when every repeat failed (no runs at all)", () => {
    const failures: VarianceCaseFailure[] = [{ caseId: "case-17", repeatIndex: 1, error: "boom" }];
    const report = buildVarianceReport({ ...baseInput, caseIds: ["case-17"], repeats: 1, runs: [], failures });
    expect(report.summary.caseCount).toBe(0);
    expect(report.summary.incompleteCaseCount).toBe(0); // nothing to be incomplete -- no case has ANY data
    expect(report.summary.stableCaseRate).toEqual({ total: 0, correct: 0, rate: 0 });
    expect(report.summary.accuracySpread).toEqual({ available: false, perRun: [], lowestRate: null, highestRate: null });
    expect(report.totalCostUsd).toBe(0);
  });

  it("passes the reviewReason for headline text through to per-repeat scoring correctly (headline reason lives in verdict.actualReviewReason)", () => {
    const runs: VarianceCaseRun[] = [caseRun("case-17", 1, "REVIEW")];
    const report = buildVarianceReport({ ...baseInput, caseIds: ["case-17"], repeats: 1, runs, failures: [] });
    const c17 = report.summary.accuracySpread.perRun[0];
    expect(c17.labelVerdictAccuracy).toEqual({ total: 1, correct: 1, rate: 1 });
    // Assert on the REPORT's own perCase output, not the input fixture —
    // asserting `runs[0]`'s field back at itself proves nothing about
    // buildVarianceReport (review finding, orchestrator pass).
    const stability = report.summary.perCase.find((c) => c.caseId === "case-17");
    expect(stability?.headlineReasons).toEqual(["AMBIGUOUS_BRAND"]);
  });

  it("sorts caseIds with the same plain comparator computeCorpusStability's perCase uses -- both orderings agree", () => {
    const runs: VarianceCaseRun[] = [caseRun("case-z", 1, "PASS"), caseRun("case-a", 1, "PASS"), caseRun("case-m", 1, "PASS")];
    const report = buildVarianceReport({ ...baseInput, caseIds: ["case-z", "case-a", "case-m"], repeats: 1, runs, failures: [] });
    expect(report.caseIds).toEqual(["case-a", "case-m", "case-z"]);
    expect(report.summary.perCase.map((c) => c.caseId)).toEqual(["case-a", "case-m", "case-z"]);
  });
});

// PR review finding (TRO-543): resolveCaseIds's default-sample path
// (DEFAULT_SAMPLE_CASE_IDS, args.ts) is a hard-coded list never filtered
// against the manifest -- a stale entry would otherwise crash deep inside
// variance.ts's own loop, possibly after real API money for earlier cases
// in the same sweep is already spent.
describe("findMissingCaseIds", () => {
  it("returns case IDs absent from knownCaseIds", () => {
    expect(findMissingCaseIds(["case-01", "case-99"], new Set(["case-01", "case-02"]))).toEqual(["case-99"]);
  });

  it("returns an empty array when every case ID is known", () => {
    expect(findMissingCaseIds(["case-01", "case-02"], new Set(["case-01", "case-02", "case-03"]))).toEqual([]);
  });

  it("returns an empty array for an empty caseIds list", () => {
    expect(findMissingCaseIds([], new Set(["case-01"]))).toEqual([]);
  });

  it("preserves input order and duplicates, if any -- it filters, it does not dedupe or sort", () => {
    expect(findMissingCaseIds(["case-99", "case-01", "case-99"], new Set(["case-01"]))).toEqual(["case-99", "case-99"]);
  });
});

// PR review finding (TRO-543): variance.ts warns before a real run's
// report would silently replace a wider committed report with a narrower
// one -- this is the pure predicate behind that warning.
describe("isNarrowerReport", () => {
  it("is true when the candidate has fewer cases", () => {
    expect(isNarrowerReport({ caseIds: ["a"], repeats: 5 }, { caseIds: ["a", "b"], repeats: 5 })).toBe(true);
  });

  it("is true when the candidate has fewer repeats, even with the same or more cases", () => {
    expect(isNarrowerReport({ caseIds: ["a", "b"], repeats: 1 }, { caseIds: ["a"], repeats: 5 })).toBe(true);
  });

  it("is false when the candidate matches the previous report exactly", () => {
    expect(isNarrowerReport({ caseIds: ["a", "b"], repeats: 5 }, { caseIds: ["a", "b"], repeats: 5 })).toBe(false);
  });

  it("is false when the candidate is wider on both axes", () => {
    expect(isNarrowerReport({ caseIds: ["a", "b", "c"], repeats: 5 }, { caseIds: ["a"], repeats: 1 })).toBe(false);
  });

  it("is true for the real scenario this finding names: a 1-case x 1-repeat proof run after a real 32-case x 3-repeat sweep", () => {
    const proofRun = { caseIds: ["case-01-clean-match-spirits"], repeats: 1 };
    const realSweep = { caseIds: Array.from({ length: 32 }, (_, i) => `case-${i}`), repeats: 3 };
    expect(isNarrowerReport(proofRun, realSweep)).toBe(true);
  });
});
