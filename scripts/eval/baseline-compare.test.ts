import { describe, expect, it } from "vitest";
import { compareToBaseline, formatBandLine, hasProblemClass, type RegressionCheckInput } from "./baseline-compare";
import type { EvalBaseline, EvalReportSummary } from "./types";

const RELIABILITY_DIAGRAM_FIXTURE = Array.from({ length: 10 }, (_, decile) => ({ decile, n: 0, correct: 0, rate: 0 }));

// Deliberately safe-by-default for BOTH banded metrics (the fixture
// baseline()'s own extractionAccuracyBand is 0.95625-0.9625, and its
// cascadeVerdictAccuracyBand is 0.78125-0.8125) — a test that overrides only
// ONE of the two banded fields must not accidentally also trip the OTHER
// one via an unrelated generic default (a real bug this file's own first
// draft hit: the old flat rate=0.9 default sat below the extraction band's
// floor and produced a spurious problem in every cascade-verdict-only test).
function summary(overrides: Partial<EvalReportSummary> = {}): EvalReportSummary {
  const rate = { total: 10, correct: 9, rate: 0.9 };
  return {
    extractionAccuracy: { total: 160, correct: 155, rate: 0.96875 },
    extractionAccuracyByField: {
      brandName: rate,
      classType: rate,
      abv: rate,
      netContents: rate,
      governmentWarning: rate,
    },
    routerVerdictAccuracy: rate,
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
      singleChannelPass: { count: 0, rate: 0 },
    },
    cascadeVerdictAccuracy: { total: 32, correct: 26, rate: 0.8125 },
    extractionReliabilityDiagram: RELIABILITY_DIAGRAM_FIXTURE,
    ...overrides,
  };
}

// The band's floor (min) is 0.781 and its ceiling (max) is 0.813 — TRO-543's
// own measured spread (78.1%-81.3%), the exact real-world band TRO-561's bug
// report is about. Every test below reasons about "at/below/above the band",
// not a single point value.
function baseline(overrides: Partial<EvalBaseline> = {}): EvalBaseline {
  return {
    ticket: "TRO-561",
    establishedAt: "2026-08-13T12:30:00.000Z",
    k: 3,
    repeats: [
      { repeatIndex: 1, extractionAccuracy: { total: 160, correct: 154, rate: 0.9625 }, cascadeVerdictAccuracy: { total: 32, correct: 26, rate: 0.8125 } },
      { repeatIndex: 2, extractionAccuracy: { total: 160, correct: 154, rate: 0.9625 }, cascadeVerdictAccuracy: { total: 32, correct: 25, rate: 0.78125 } },
      { repeatIndex: 3, extractionAccuracy: { total: 160, correct: 153, rate: 0.95625 }, cascadeVerdictAccuracy: { total: 32, correct: 25, rate: 0.78125 } },
    ],
    extractionAccuracyBand: { min: 0.95625, max: 0.9625, spread: 0.00625 },
    cascadeVerdictAccuracyBand: { min: 0.78125, max: 0.8125, spread: 0.03125 },
    perCaseVerdictSets: {},
    manifestVersion: "1.0.0",
    manifestContentHash: "hash-a",
    goldenSetCommitSha: "deadbeef",
    caseIds: ["case-01", "case-02"],
    haikuModel: "claude-haiku-4-5",
    sonnetModel: "claude-sonnet-5",
    codeCommitSha: "cafed00d",
    costUsd: { totalUsd: 0.95, meanHaikuCallUsd: 0.003, meanSonnetCallUsd: 0.02 },
    ...overrides,
  };
}

function current(overrides: Partial<RegressionCheckInput> = {}): RegressionCheckInput {
  return {
    manifestVersion: "1.0.0",
    manifestContentHash: "hash-a",
    caseIds: ["case-01", "case-02"],
    summary: summary(),
    ...overrides,
  };
}

describe("compareToBaseline", () => {
  // --- Acceptance evidence: a run at the band floor passes ---------------
  it("passes when cascade-verdict accuracy is exactly at the band's floor (0.78125) — the whole point of a band floor, not a single pinned point", () => {
    const atFloor = summary({ cascadeVerdictAccuracy: { total: 32, correct: 25, rate: 0.78125 } });
    const result = compareToBaseline(current({ summary: atFloor }), baseline());
    expect(result.problems).toEqual([]);
    expect(hasProblemClass(result, "accuracy-below-band")).toBe(false);
  });

  it("passes when extraction accuracy is exactly at its own band floor (0.95625)", () => {
    const atFloor = summary({ extractionAccuracy: { total: 160, correct: 153, rate: 0.95625 } });
    const result = compareToBaseline(current({ summary: atFloor }), baseline());
    expect(hasProblemClass(result, "accuracy-below-band")).toBe(false);
  });

  it("is not a problem when current sits inside the band, between floor and ceiling", () => {
    const midBand = summary({ cascadeVerdictAccuracy: { total: 32, correct: 25, rate: 0.8 } });
    const result = compareToBaseline(current({ summary: midBand }), baseline());
    expect(result.problems).toEqual([]);
  });

  it("is not a problem when current exceeds the band's own ceiling", () => {
    const aboveBand = summary({ cascadeVerdictAccuracy: { total: 32, correct: 30, rate: 0.9375 } });
    const result = compareToBaseline(current({ summary: aboveBand }), baseline());
    expect(result.problems).toEqual([]);
  });

  // --- Acceptance evidence: a run clearly below it fails ------------------
  it("fails, classified accuracy-below-band, when cascade-verdict accuracy is clearly below the band floor", () => {
    const clearlyBelow = summary({ cascadeVerdictAccuracy: { total: 32, correct: 22, rate: 0.6875 } });
    const result = compareToBaseline(current({ summary: clearlyBelow }), baseline());
    const problem = result.problems.find((p) => p.problemClass === "accuracy-below-band" && p.message.includes("cascade-verdict"));
    expect(problem).toBeDefined();
    expect(problem!.message).toMatch(/BELOW the measured 78\.1%-81\.3% band \(K=3\)/);
  });

  it("fails, classified accuracy-below-band, when extraction accuracy is clearly below its band floor", () => {
    const clearlyBelow = summary({ extractionAccuracy: { total: 160, correct: 120, rate: 0.75 } });
    const result = compareToBaseline(current({ summary: clearlyBelow }), baseline());
    const problem = result.problems.find((p) => p.problemClass === "accuracy-below-band" && p.message.includes("extraction accuracy"));
    expect(problem).toBeDefined();
  });

  it("collects every accuracy-below-band problem, not just the first", () => {
    const bothWorse = summary({
      extractionAccuracy: { total: 160, correct: 100, rate: 0.625 },
      cascadeVerdictAccuracy: { total: 32, correct: 10, rate: 0.3125 },
    });
    const result = compareToBaseline(current({ summary: bothWorse }), baseline());
    expect(result.problems.filter((p) => p.problemClass === "accuracy-below-band")).toHaveLength(2);
  });

  it("never bands routerVerdictAccuracy or reviewReasonAccuracy — a drop in either produces no problem (EvalBaseline's own doc comment: reported, not gated)", () => {
    const worseButNotBanded = summary({
      routerVerdictAccuracy: { total: 10, correct: 1, rate: 0.1 },
      reviewReasonAccuracy: { total: 10, correct: 0, rate: 0 },
    });
    const result = compareToBaseline(current({ summary: worseButNotBanded }), baseline());
    expect(result.problems).toEqual([]);
  });

  // --- Acceptance evidence: a hash-mismatched baseline reports stale-baseline (not regression) ---
  it("reports stale-baseline, NOT accuracy-below-band, when the manifest content hash differs — even when accuracy also looks worse", () => {
    const worseAndStale = summary({ cascadeVerdictAccuracy: { total: 32, correct: 20, rate: 0.625 } });
    const result = compareToBaseline(current({ manifestContentHash: "hash-b", summary: worseAndStale }), baseline());
    const staleProblems = result.problems.filter((p) => p.problemClass === "stale-baseline");
    expect(staleProblems).toHaveLength(1);
    expect(staleProblems[0].message).toMatch(/manifest content changed/);
    expect(staleProblems[0].message).not.toMatch(/regressed/);
    // The accuracy drop is STILL its own, separately classified problem —
    // staleness does not swallow a real accuracy-below-band finding.
    expect(result.problems.some((p) => p.problemClass === "accuracy-below-band")).toBe(true);
  });

  it("reports stale-baseline when only manifestVersion differs, content hash agreeing", () => {
    const result = compareToBaseline(current({ manifestVersion: "2.0.0" }), baseline());
    const staleProblems = result.problems.filter((p) => p.problemClass === "stale-baseline");
    expect(staleProblems).toHaveLength(1);
    expect(staleProblems[0].message).toMatch(/manifest version mismatch/);
  });

  it("reports stale-baseline with no accuracy-below-band problem when only the corpus moved and accuracy is otherwise fine", () => {
    const result = compareToBaseline(current({ manifestContentHash: "hash-b" }), baseline());
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].problemClass).toBe("stale-baseline");
  });

  it("points a stale-baseline message at the re-baseline protocol's own invocation", () => {
    const result = compareToBaseline(current({ manifestContentHash: "hash-b" }), baseline());
    expect(result.problems[0].message).toContain("eval:variance -- --live --full --repeats=3 --establish-baseline");
  });

  // --- Acceptance evidence: a coverage gap reports as its own class -------
  it("reports coverage-mismatch, not accuracy-below-band or stale-baseline, when current omits a baseline case", () => {
    const result = compareToBaseline(current({ caseIds: ["case-01"] }), baseline());
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].problemClass).toBe("coverage-mismatch");
    expect(result.problems[0].message).toMatch(/coverage mismatch/);
    expect(result.problems[0].message).toContain("case-02");
  });

  it("is not a problem when current covers a superset of the baseline's cases", () => {
    const result = compareToBaseline(current({ caseIds: ["case-01", "case-02", "case-03"] }), baseline());
    expect(result.problems).toEqual([]);
  });

  it("names every missing case, not just the count, when multiple are absent", () => {
    const result = compareToBaseline(
      current({ caseIds: [] }),
      baseline({ caseIds: ["case-01", "case-02", "case-03"] }),
    );
    const problem = result.problems.find((p) => p.problemClass === "coverage-mismatch")!;
    expect(problem.message).toContain("case-01");
    expect(problem.message).toContain("case-02");
    expect(problem.message).toContain("case-03");
  });

  // --- All three classes can co-occur, each named -------------------------
  it("reports all three problem classes at once when all three conditions hold, each correctly classified", () => {
    const clearlyBelow = summary({ cascadeVerdictAccuracy: { total: 32, correct: 10, rate: 0.3125 } });
    const result = compareToBaseline(
      current({ manifestContentHash: "hash-b", caseIds: ["case-01"], summary: clearlyBelow }),
      baseline(),
    );
    const classes = result.problems.map((p) => p.problemClass).sort();
    expect(classes).toEqual(["accuracy-below-band", "coverage-mismatch", "stale-baseline"]);
  });

  it("is a clean comparison (no problems) when everything matches and both banded rates clear their floors", () => {
    const result = compareToBaseline(current(), baseline());
    expect(result.problems).toEqual([]);
  });
});

describe("hasProblemClass", () => {
  it("is true exactly when a problem of that class is present", () => {
    const result = compareToBaseline(current({ manifestContentHash: "hash-b" }), baseline());
    expect(hasProblemClass(result, "stale-baseline")).toBe(true);
    expect(hasProblemClass(result, "accuracy-below-band")).toBe(false);
    expect(hasProblemClass(result, "coverage-mismatch")).toBe(false);
  });
});

describe("formatBandLine", () => {
  const band = { min: 0.78125, max: 0.8125, spread: 0.03125 };

  it("reports \"is within the measured X-Y band\" when the rate is at or above the floor", () => {
    expect(formatBandLine("cascade-verdict accuracy", 0.78125, band, 3)).toBe(
      "cascade-verdict accuracy 78.1% is within the measured 78.1%-81.3% band (K=3).",
    );
  });

  it("reports \"is BELOW the measured X-Y band\" when the rate is under the floor", () => {
    expect(formatBandLine("cascade-verdict accuracy", 0.74, band, 3)).toBe(
      "cascade-verdict accuracy 74.0% is BELOW the measured 78.1%-81.3% band (K=3).",
    );
  });
});
