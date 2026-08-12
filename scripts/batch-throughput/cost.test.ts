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
});
