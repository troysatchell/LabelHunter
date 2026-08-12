/**
 * Tests for the warning subsystem's own edit-distance function (LH-020 /
 * TRO-468). Written before `distance.ts` — TDD, PRD §6.
 *
 * Deliberately NOT imported from `../comparators/similarity.ts` — CP-1
 * §Q11 / standing rule 11: the two matching regimes share no helpers, and
 * this ticket ("own component") keeps its own self-contained copy of even
 * a generic algorithm like Levenshtein distance, so the "no shared
 * helpers" property holds with zero exceptions.
 */
import { describe, expect, it } from "vitest";
import { levenshteinDistance } from "./distance";

describe("levenshteinDistance", () => {
  it("is 0 for identical strings", () => {
    expect(levenshteinDistance("same", "same")).toBe(0);
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("is the length of the other string when one side is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  it("counts a single substitution as distance 1", () => {
    expect(levenshteinDistance("cat", "cot")).toBe(1);
  });

  it("counts a single insertion or deletion as distance 1", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });

  it("counts a missing comma as distance 1 — CP-2 §2.6's boot-camp example", () => {
    const withComma = "according to the surgeon general, women should not";
    const withoutComma = "according to the surgeon general women should not";
    expect(levenshteinDistance(withComma, withoutComma)).toBe(1);
  });

  it("is symmetric", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(levenshteinDistance("sitting", "kitten"));
  });
});
