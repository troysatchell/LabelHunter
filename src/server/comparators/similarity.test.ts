/**
 * Tests for the character-level similarity score `compareBrandOrClass`
 * thresholds against (LH-013 / TRO-463, CP-1 §5.3 `AMBIGUOUS_BRAND`'s
 * `>= 0.95` / `< 0.95` table). Written before `similarity.ts`'s
 * implementation — TDD, PRD §6.
 */
import { describe, expect, it } from "vitest";
import { similarity } from "./similarity";

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
});
