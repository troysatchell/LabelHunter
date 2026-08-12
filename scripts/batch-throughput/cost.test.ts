import { describe, expect, it } from "vitest";
import { deriveBatchCostUsd, meanCost } from "./cost";

describe("meanCost", () => {
  it("computes the arithmetic mean of real per-call costs", () => {
    expect(meanCost([0.004, 0.005, 0.006])).toBeCloseTo(0.005, 10);
  });

  it("handles a single value", () => {
    expect(meanCost([0.0125])).toBe(0.0125);
  });

  it("throws on an empty list rather than returning a fabricated 0", () => {
    expect(() => meanCost([])).toThrow(RangeError);
  });

  it("throws on a negative cost (review finding, local review round 2)", () => {
    expect(() => meanCost([0.005, -0.001])).toThrow(RangeError);
  });

  it("throws on a non-finite cost (NaN or Infinity)", () => {
    expect(() => meanCost([0.005, Number.NaN])).toThrow(RangeError);
    expect(() => meanCost([0.005, Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});

describe("deriveBatchCostUsd", () => {
  it("combines real Haiku and Sonnet call counts with their measured mean costs", () => {
    const usd = deriveBatchCostUsd({
      haikuCallCount: 32,
      haikuMeanCostUsd: 0.004668,
      sonnetCallCount: 13,
      sonnetMeanCostUsd: 0.010969,
    });
    // 32 * 0.004668 + 13 * 0.010969 = 0.149376 + 0.142597 = 0.291973
    expect(usd).toBeCloseTo(0.291973, 6);
  });

  it("returns just the Haiku cost when no Sonnet call happened", () => {
    const usd = deriveBatchCostUsd({
      haikuCallCount: 10,
      haikuMeanCostUsd: 0.004668,
      sonnetCallCount: 0,
      sonnetMeanCostUsd: 0.010969,
    });
    expect(usd).toBeCloseTo(0.04668, 6);
  });

  it("prices every claimed attempt — haikuCallCount is an upper bound on real Haiku calls, not a label count", () => {
    // 5 labels, one of which retried once: 6 claimed attempts. An attempt
    // can fail before its request ever reaches Haiku, so 6 bounds the real
    // call count from above; it does not certify it.
    const usd = deriveBatchCostUsd({ haikuCallCount: 6, haikuMeanCostUsd: 0.004668, sonnetCallCount: 0, sonnetMeanCostUsd: 0.010969 });
    expect(usd).toBeCloseTo(6 * 0.004668, 6);
  });

  it("throws on a negative call count (review finding, local review round 2)", () => {
    expect(() => deriveBatchCostUsd({ haikuCallCount: -1, haikuMeanCostUsd: 0.004668, sonnetCallCount: 0, sonnetMeanCostUsd: 0.010969 })).toThrow(
      RangeError,
    );
    expect(() => deriveBatchCostUsd({ haikuCallCount: 10, haikuMeanCostUsd: 0.004668, sonnetCallCount: -1, sonnetMeanCostUsd: 0.010969 })).toThrow(
      RangeError,
    );
  });

  it("throws on a non-finite mean cost", () => {
    expect(() => deriveBatchCostUsd({ haikuCallCount: 10, haikuMeanCostUsd: Number.NaN, sonnetCallCount: 0, sonnetMeanCostUsd: 0.010969 })).toThrow(
      RangeError,
    );
  });

  it("throws on a NaN call count rather than silently producing a NaN total (review finding, local review round 3)", () => {
    // Regression: a bare `< 0` check never catches NaN (NaN < 0 is false),
    // so the round-2 version of this check let a NaN call count through
    // and produced a NaN result instead of a thrown error.
    expect(() =>
      deriveBatchCostUsd({ haikuCallCount: Number.NaN, haikuMeanCostUsd: 0.004668, sonnetCallCount: 0, sonnetMeanCostUsd: 0.010969 }),
    ).toThrow(RangeError);
  });

  it("throws on a non-integer call count", () => {
    expect(() => deriveBatchCostUsd({ haikuCallCount: 1.5, haikuMeanCostUsd: 0.004668, sonnetCallCount: 0, sonnetMeanCostUsd: 0.010969 })).toThrow(
      RangeError,
    );
  });

  it("throws on a negative mean cost", () => {
    expect(() => deriveBatchCostUsd({ haikuCallCount: 10, haikuMeanCostUsd: -0.001, sonnetCallCount: 0, sonnetMeanCostUsd: 0.010969 })).toThrow(
      RangeError,
    );
  });
});
