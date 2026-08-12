import { describe, expect, it } from "vitest";
import { computeLatencyStats } from "./latency-stats";

describe("computeLatencyStats", () => {
  it("returns null for zero samples — never a fabricated number", () => {
    expect(computeLatencyStats([])).toBeNull();
  });

  it("returns the single sample itself as both avg and p95", () => {
    expect(computeLatencyStats([2000])).toEqual({ count: 1, avgMs: 2000, p95Ms: 2000 });
  });

  it("computes avg and p95 (nearest-rank) for a known set", () => {
    // 10 samples, 1000..10000 ms. p95 rank = ceil(0.95 * 10) = 10th (largest).
    const durations = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    const stats = computeLatencyStats(durations);
    expect(stats).toEqual({ count: 10, avgMs: 5500, p95Ms: 10000 });
  });

  it("computes p95 as the same real sample regardless of input order", () => {
    const ascending = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    const shuffled = [7000, 1000, 9000, 3000, 10000, 2000, 6000, 4000, 8000, 5000];
    expect(computeLatencyStats(shuffled)).toEqual(computeLatencyStats(ascending));
  });

  it("rounds the average to the nearest millisecond", () => {
    const stats = computeLatencyStats([1000, 2000, 2000]);
    expect(stats?.avgMs).toBe(1667); // 5000 / 3 = 1666.67
  });

  it("does not mutate its input array", () => {
    const durations = [3000, 1000, 2000];
    const copy = [...durations];
    computeLatencyStats(durations);
    expect(durations).toEqual(copy);
  });

  it("rejects a negative duration — never a fabricated measurement", () => {
    expect(() => computeLatencyStats([1000, -5])).toThrow(RangeError);
  });

  it("rejects a non-finite duration", () => {
    expect(() => computeLatencyStats([1000, Number.NaN])).toThrow(RangeError);
    expect(() => computeLatencyStats([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});
