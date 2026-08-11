/**
 * Tests for the latency harness's own math (TRO-471 / LH-031, TH-R2).
 * Written before `percentile.ts`'s implementation — TDD, PRD §6. Every
 * input here is a synthetic, hand-picked array of millisecond durations —
 * no live call, no network, no Anthropic API. This file is a fast unit
 * test the gate runs on every `pnpm test`, distinct from `measure.ts`,
 * which spends real money and never runs inside the gate.
 */
import { describe, expect, it } from "vitest";
import { percentile, summarizeLatencies } from "./percentile";

describe("percentile — nearest-rank, PRD §3.8's p50/p95", () => {
  it("throws on an empty array — never silently returns NaN (standing rule 12)", () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
  });

  it("throws on a percentile below 0 or above 100", () => {
    expect(() => percentile([1, 2, 3], -1)).toThrow(RangeError);
    expect(() => percentile([1, 2, 3], 101)).toThrow(RangeError);
  });

  it("returns the single value for any valid percentile when there is one sample", () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it("computes p50 on 10 sorted samples by the nearest-rank method (rank = ceil(p/100 * n))", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = ceil(0.50 * 10) = 5 -> the 5th-smallest value, index 4.
    expect(percentile(samples, 50)).toBe(5);
  });

  it("computes p95 on 10 sorted samples by the nearest-rank method", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = ceil(0.95 * 10) = 10 -> the 10th-smallest value, index 9.
    expect(percentile(samples, 95)).toBe(10);
  });

  it("does not require the caller to pre-sort — a shuffled array gives the same result", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = [7, 2, 10, 4, 1, 9, 3, 6, 8, 5];
    expect(percentile(shuffled, 50)).toBe(percentile(sorted, 50));
    expect(percentile(shuffled, 95)).toBe(percentile(sorted, 95));
  });

  it("never mutates the array passed in", () => {
    const samples = [5, 3, 1, 4, 2];
    const copy = [...samples];
    percentile(samples, 50);
    expect(samples).toEqual(copy);
  });

  it("computes p50 and p95 on 20 samples — the harness's own realistic sample size", () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    // rank = ceil(0.50 * 20) = 10 -> index 9 -> 1000.
    expect(percentile(samples, 50)).toBe(1000);
    // rank = ceil(0.95 * 20) = 19 -> index 18 -> 1900.
    expect(percentile(samples, 95)).toBe(1900);
  });

  it("rejects a NaN entry instead of sorting it in — never a silent wrong answer", () => {
    expect(() => percentile([100, NaN, 200], 50)).toThrow(RangeError);
    expect(() => percentile([100, NaN, 200], 50)).toThrow(/finite/);
  });

  it("rejects an Infinity entry — JSON.stringify would otherwise silently turn it into null", () => {
    expect(() => percentile([100, Infinity, 200], 50)).toThrow(RangeError);
    expect(() => percentile([100, -Infinity, 200], 95)).toThrow(RangeError);
  });

  it("rejects a negative entry — a duration cannot be less than zero", () => {
    expect(() => percentile([100, -1, 200], 50)).toThrow(RangeError);
    expect(() => percentile([100, -1, 200], 50)).toThrow(/negative/);
  });

  it("accepts zero — an immediate, near-instant call is a real, valid duration", () => {
    expect(percentile([0, 100, 200], 50)).toBe(100);
  });
});

describe("summarizeLatencies — count/min/max/mean/p50/p95 from one function call", () => {
  it("throws on an empty array — never reports a summary with no data", () => {
    expect(() => summarizeLatencies([])).toThrow(RangeError);
  });

  it("summarizes a small known array", () => {
    const summary = summarizeLatencies([2000, 3000, 4000, 5000, 6000]);
    expect(summary.count).toBe(5);
    expect(summary.min).toBe(2000);
    expect(summary.max).toBe(6000);
    expect(summary.mean).toBe(4000);
    // rank = ceil(0.50 * 5) = 3 -> index 2 -> 4000.
    expect(summary.p50).toBe(4000);
    // rank = ceil(0.95 * 5) = 5 -> index 4 -> 6000.
    expect(summary.p95).toBe(6000);
  });

  it("agrees with calling percentile() directly for p50 and p95", () => {
    const samples = [3100, 2900, 3400, 3050, 2800, 3600, 3000, 3300, 2950, 3150];
    const summary = summarizeLatencies(samples);
    expect(summary.p50).toBe(percentile(samples, 50));
    expect(summary.p95).toBe(percentile(samples, 95));
  });

  it("rounds mean to the nearest millisecond for a readable report", () => {
    const summary = summarizeLatencies([1, 2, 4]);
    // mean is 7/3 = 2.333... — rounded, not truncated or left as a repeating decimal.
    expect(summary.mean).toBe(2);
  });

  it("rejects a NaN or Infinity entry — a bad duration must fail loudly, not corrupt the report", () => {
    expect(() => summarizeLatencies([2000, NaN, 4000])).toThrow(RangeError);
    expect(() => summarizeLatencies([2000, Infinity, 4000])).toThrow(RangeError);
  });

  it("rejects a negative entry — a duration cannot be less than zero", () => {
    expect(() => summarizeLatencies([2000, -1, 4000])).toThrow(RangeError);
    expect(() => summarizeLatencies([2000, -1, 4000])).toThrow(/negative/);
  });
});
