/**
 * Tests for the character-level similarity score `compareBrandOrClass`
 * thresholds against (LH-013 / TRO-463, CP-1 §5.3 `AMBIGUOUS_BRAND`'s
 * `>= 0.95` / `< 0.95` table). Written before `similarity.ts`'s
 * implementation — TDD, PRD §6.
 */
import { describe, expect, it } from "vitest";
import { levenshteinDistance, similarity } from "./similarity";

describe("levenshteinDistance — the raw edit count similarity.ts builds on", () => {
  it("is 0 for identical strings", () => {
    expect(levenshteinDistance("stone's throw", "stone's throw")).toBe(0);
  });

  it("counts a single deletion as distance 1", () => {
    expect(levenshteinDistance("stone's throw", "stones throw")).toBe(1);
  });

  it("counts a single substitution as distance 1", () => {
    expect(levenshteinDistance("cat", "cot")).toBe(1);
  });

  it("equals the longer string's length against an empty string", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });
});

describe("similarity — normalized edit distance, 0..1", () => {
  it("is 1 for identical strings", () => {
    expect(similarity("stone's throw", "stone's throw")).toBe(1);
  });

  it("is 1 for two empty strings", () => {
    expect(similarity("", "")).toBe(1);
  });

  it("is 0 for an empty string against a non-empty one", () => {
    expect(similarity("", "stone's throw")).toBe(0);
  });

  it("is high but not 1 for a single-character typo in a longer string", () => {
    const score = similarity("stone's throw", "stone's throwe");
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThan(1);
  });

  it("is low for two strings that share almost nothing", () => {
    expect(similarity("stone's throw", "northwind cellars")).toBeLessThan(0.5);
  });

  it("is symmetric", () => {
    expect(similarity("abc", "abd")).toBe(similarity("abd", "abc"));
  });

  it("pins both sides of `brand.ts`'s 0.95 decision threshold with real numbers", () => {
    // "old tom distillery" (18 chars) vs "old tom distillry" (17 chars, one
    // dropped letter) — a single deletion over an 18-character string is
    // 1 - 1/18 = 0.9444..., just under 0.95: NEEDS_REVIEW's side.
    const belowThreshold = similarity("old tom distillery", "old tom distillry");
    expect(belowThreshold).toBeLessThan(0.95);
    expect(belowThreshold).toBeCloseTo(17 / 18, 5);

    // "old tom distillery co" (21 chars) vs the same text plus a trailing
    // period (22 chars) — a single edit over 22 chars is 1 - 1/22 =
    // 0.9545..., at or above 0.95: MATCH's side.
    const atOrAboveThreshold = similarity("old tom distillery co", "old tom distillery co.");
    expect(atOrAboveThreshold).toBeGreaterThanOrEqual(0.95);
    expect(atOrAboveThreshold).toBeCloseTo(21 / 22, 5);
  });
});
