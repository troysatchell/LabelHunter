import { describe, expect, it } from "vitest";
import { computeAutoVerifiedShare, computeBatchThroughput } from "./batch-throughput";

describe("computeBatchThroughput", () => {
  it("computes items/minute and the reciprocal per-item average for a real elapsed span", () => {
    const startedAt = new Date("2026-08-12T00:00:00.000Z");
    const completedAt = new Date("2026-08-12T00:02:00.000Z"); // 2 minutes, 10 items
    const result = computeBatchThroughput({ totalCount: 10, startedAt, completedAt });
    expect(result).not.toBeNull();
    expect(result?.itemsPerMinute).toBe(5);
    expect(result?.avgMsPerItem).toBe(12_000); // 120_000ms / 10
  });

  it("rounds items/minute to 2 decimal places for a batch that does not divide evenly", () => {
    const startedAt = new Date("2026-08-12T00:00:00.000Z");
    const completedAt = new Date("2026-08-12T00:01:30.000Z"); // 90 seconds, 25 items
    const result = computeBatchThroughput({ totalCount: 25, startedAt, completedAt });
    // 25 items / 1.5 minutes = 16.666... -> 16.67
    expect(result?.itemsPerMinute).toBe(16.67);
    expect(result?.avgMsPerItem).toBe(3_600); // 90_000ms / 25
  });

  it("returns null when the batch has not started", () => {
    const result = computeBatchThroughput({ totalCount: 10, startedAt: null, completedAt: null });
    expect(result).toBeNull();
  });

  it("returns null when the batch has started but not completed — never a fabricated in-flight rate", () => {
    const result = computeBatchThroughput({
      totalCount: 10,
      startedAt: new Date("2026-08-12T00:00:00.000Z"),
      completedAt: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when totalCount is 0 rather than dividing by zero", () => {
    const result = computeBatchThroughput({
      totalCount: 0,
      startedAt: new Date("2026-08-12T00:00:00.000Z"),
      completedAt: new Date("2026-08-12T00:01:00.000Z"),
    });
    expect(result).toBeNull();
  });

  it("throws RangeError when completedAt is before startedAt", () => {
    expect(() =>
      computeBatchThroughput({
        totalCount: 10,
        startedAt: new Date("2026-08-12T00:01:00.000Z"),
        completedAt: new Date("2026-08-12T00:00:00.000Z"),
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when completedAt equals startedAt — a zero-duration batch is not a real rate", () => {
    const same = new Date("2026-08-12T00:00:00.000Z");
    expect(() => computeBatchThroughput({ totalCount: 10, startedAt: same, completedAt: same })).toThrow(RangeError);
  });
});

describe("computeAutoVerifiedShare", () => {
  it("computes the share of processed labels finished without a resolver call", () => {
    // 18 auto-verified out of 25 processed.
    expect(computeAutoVerifiedShare(18, 25)).toBe(0.72);
  });

  it("returns null when nothing has processed yet — never a fabricated 0%", () => {
    expect(computeAutoVerifiedShare(0, 0)).toBeNull();
  });

  it("returns 1 when every processed label was auto-verified", () => {
    expect(computeAutoVerifiedShare(10, 10)).toBe(1);
  });

  it("returns 0 when every processed label needed the resolver or a human", () => {
    expect(computeAutoVerifiedShare(0, 10)).toBe(0);
  });

  it("throws RangeError when autoVerifiedCount exceeds processedCount", () => {
    expect(() => computeAutoVerifiedShare(11, 10)).toThrow(RangeError);
  });

  it("throws RangeError when autoVerifiedCount is negative", () => {
    expect(() => computeAutoVerifiedShare(-1, 10)).toThrow(RangeError);
  });
});
