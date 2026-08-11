/**
 * Regression tests for TRO-504 items 1 and 2 (deferred from TRO-462's gate
 * run, closed here by LH-013 / TRO-463 per the batch brief).
 *
 * `text-boundary.ts` had no test file of its own before this ticket — its
 * behavior was only exercised indirectly through `overrides.test.ts`. These
 * two bugs are precise enough to deserve named, direct tests.
 *
 * Both fixes stay inside this file's own narrow scope (CP-1 §4.4 rule 2's
 * anti-hallucination evidence check) — neither adds diacritic folding here;
 * that stays the real fuzzy-match pipeline's job (`../comparators/normalize.ts`).
 */
import { describe, expect, it } from "vitest";
import { evidenceSupportsTextValue, normalizeForBoundaryMatch } from "./text-boundary";

describe("evidenceSupportsTextValue — TRO-504 item 1: combining marks in the boundary class", () => {
  it("does NOT treat an unaccented value as supported by evidence bearing the same base letters plus a combining accent", () => {
    // "jose" (unaccented) must not silently pass against evidence that
    // actually reads the accented word "josé" — an NFD-decomposed "e" +
    // COMBINING ACUTE ACCENT (U+0301) sits right after "jos-e", and without
    // \p{M} in the lookaround, that combining mark reads as "not a letter",
    // which wrongly looks like a word boundary.
    const nfdEvidence = "José Distillery"; // NFD "José Distillery"
    expect(evidenceSupportsTextValue("Jose", nfdEvidence)).toBe(false);
  });

  it("still matches when the value and evidence carry the identical accented spelling", () => {
    expect(evidenceSupportsTextValue("José", "José Distillery")).toBe(true);
  });

  it("still rejects a plain substring that is not at a real word boundary (no regression on the existing rule)", () => {
    expect(evidenceSupportsTextValue("Tom", "Tomintoul Distillery")).toBe(false);
  });

  it("still matches an ordinary word at a true boundary", () => {
    expect(evidenceSupportsTextValue("Old Tom", "Old Tom Distillery")).toBe(true);
  });
});

describe("normalizeForBoundaryMatch — TRO-504 item 2: German ß case-folding", () => {
  it("folds ß to 'ss' — toLowerCase() alone leaves ß untouched", () => {
    expect(normalizeForBoundaryMatch("Straße")).toBe(normalizeForBoundaryMatch("STRASSE"));
    expect(normalizeForBoundaryMatch("STRASSE")).toBe("strasse");
  });

  it("lets an unaccented ss-spelled value word-boundary-match ß-bearing evidence", () => {
    expect(evidenceSupportsTextValue("Weissbier", "Weißbier Haus")).toBe(true);
  });

  it("still casefolds plain ASCII as before", () => {
    expect(normalizeForBoundaryMatch("OLD TOM")).toBe("old tom");
  });
});
