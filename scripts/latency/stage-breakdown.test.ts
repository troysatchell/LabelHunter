/**
 * Tests for `stage-breakdown.ts` (TRO-539). Pure, no I/O, no live call, no
 * real money.
 */
import { describe, expect, it } from "vitest";
import { buildStageBreakdown } from "./stage-breakdown";

describe("buildStageBreakdown", () => {
  it("returns null when no run carries any serverTimingMs", () => {
    expect(buildStageBreakdown([{ ok: true }, { ok: true }])).toBeNull();
  });

  it("returns null on an empty run list", () => {
    expect(buildStageBreakdown([])).toBeNull();
  });

  it("summarizes samples from successful runs", () => {
    const breakdown = buildStageBreakdown([
      { ok: true, serverTimingMs: { preprocess: 10, haiku: 2000, ocr: 300, router: 1, db: 5 } },
      { ok: true, serverTimingMs: { preprocess: 20, haiku: 2200, ocr: 350, router: 2, db: 10 } },
    ]);
    expect(breakdown).not.toBeNull();
    expect(breakdown?.preprocess?.count).toBe(2);
    expect(breakdown?.preprocess?.p50).toBeCloseTo(10, 5); // nearest-rank p50 of [10, 20] is 10 (percentile.ts's own rule)
    expect(breakdown?.haiku?.count).toBe(2);
  });

  // CodeRabbit local review round 1 (major): a failed or malformed-body
  // run must never contribute a timing sample, even if it happens to
  // carry a serverTimingMs value (route.ts never attaches one to a
  // non-200 response today, but --url mode can point at any server).
  it("excludes a FAILED run's serverTimingMs, even though it is present", () => {
    const breakdown = buildStageBreakdown([
      { ok: true, serverTimingMs: { preprocess: 10, haiku: 2000, ocr: 300, router: 1, db: 5 } },
      // A failed run that (from an unrelated server, a proxy, or a future
      // route.ts bug) still carries a header — must not count.
      { ok: false, serverTimingMs: { preprocess: 99999, haiku: 99999, ocr: 99999, router: 99999, db: 99999 } },
    ]);
    expect(breakdown?.preprocess?.count).toBe(1);
    expect(breakdown?.preprocess?.max).toBe(10);
    expect(breakdown?.haiku?.max).toBe(2000);
  });

  it("excludes a run with ok: false and no serverTimingMs at all (the normal failure shape)", () => {
    const breakdown = buildStageBreakdown([
      { ok: true, serverTimingMs: { preprocess: 10, haiku: 2000, ocr: 300, router: 1, db: 5 } },
      { ok: false },
    ]);
    expect(breakdown?.preprocess?.count).toBe(1);
  });

  it("handles a stage present in some successful runs but not others", () => {
    const breakdown = buildStageBreakdown([
      { ok: true, serverTimingMs: { haiku: 2000 } },
      { ok: true, serverTimingMs: {} },
    ]);
    expect(breakdown?.haiku?.count).toBe(1);
    expect(breakdown?.preprocess).toBeUndefined();
  });

  it("never throws when a successful run has no serverTimingMs at all", () => {
    expect(() => buildStageBreakdown([{ ok: true }, { ok: true, serverTimingMs: { db: 5 } }])).not.toThrow();
    expect(buildStageBreakdown([{ ok: true }, { ok: true, serverTimingMs: { db: 5 } }])?.db?.count).toBe(1);
  });
});
