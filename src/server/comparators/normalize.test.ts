/**
 * Tests for the real fuzzy-match normalizer (LH-013 / TRO-463, CP-1 §5.3
 * `AMBIGUOUS_BRAND`'s fixed 6-step pipeline). Written before
 * `normalize.ts`'s implementation — TDD, PRD §6.
 *
 * This pipeline is for the JUDGMENT regime only (TH-R8: brand_name,
 * class_type). It never runs on the government warning — that is the exact
 * regime, LH-020's own subsystem (CP-1 §2.3, §Q11: "separate normalizers,
 * separate comparators, no shared helpers between the two").
 */
import { describe, expect, it } from "vitest";
import { normalizeForFuzzyMatch } from "./normalize";

describe("normalizeForFuzzyMatch — CP-1 §5.3's 6-step pipeline, in order", () => {
  it("step 1 (Unicode NFKC): a fullwidth spelling normalizes the same as its ASCII form", () => {
    // U+FF33 etc. — fullwidth Latin letters, canonically compatible with ASCII under NFKC.
    expect(normalizeForFuzzyMatch("Ｓｔｏｎｅ")).toBe(normalizeForFuzzyMatch("Stone"));
  });

  it("step 2 (casefold): CP-1's own worked example — STONE'S THROW = Stone's Throw", () => {
    expect(normalizeForFuzzyMatch("STONE'S THROW")).toBe(normalizeForFuzzyMatch("Stone's Throw"));
    expect(normalizeForFuzzyMatch("STONE'S THROW")).toBe("stone's throw");
  });

  it("step 2 (casefold): German ß folds to 'ss' — toLowerCase() alone does not do this (TRO-504 item 2)", () => {
    // All-caps German orthography spells ß as "SS" (there is traditionally no
    // uppercase ß) — "WEISSBIER" and "Weißbier" name the same product.
    expect(normalizeForFuzzyMatch("WEISSBIER")).toBe(normalizeForFuzzyMatch("Weißbier"));
    expect(normalizeForFuzzyMatch("Weißbier")).toBe("weissbier");
  });

  it("step 3 (apostrophe folding): the three named variants (', `, ´) all fold to '", () => {
    expect(normalizeForFuzzyMatch("Stone`s Throw")).toBe(normalizeForFuzzyMatch("Stone's Throw"));
    expect(normalizeForFuzzyMatch("Stone´s Throw")).toBe(normalizeForFuzzyMatch("Stone's Throw"));
  });

  it("step 4 (diacritic stripping): an accented and unaccented spelling normalize the same", () => {
    expect(normalizeForFuzzyMatch("José")).toBe(normalizeForFuzzyMatch("Jose"));
    expect(normalizeForFuzzyMatch("José")).toBe("jose");
  });

  it("a combining-mark (NFD-decomposed) accent normalizes identically to its precomposed form (TRO-504 item 1)", () => {
    // "e" (U+0065) + COMBINING ACUTE ACCENT (U+0301) is NFD "é" — the same
    // visible word as the single precomposed U+00E9 codepoint used above.
    const nfdJose = "José"; // "José", decomposed
    expect(normalizeForFuzzyMatch(nfdJose)).toBe(normalizeForFuzzyMatch("José"));
    expect(normalizeForFuzzyMatch(nfdJose)).toBe("jose");
  });

  it("step 5 (whitespace): collapses runs of internal whitespace and trims the ends", () => {
    expect(normalizeForFuzzyMatch("  Stone's   Throw  ")).toBe("stone's throw");
  });

  it("step 6 (punctuation): drops punctuation other than internal apostrophes and hyphens", () => {
    expect(normalizeForFuzzyMatch("Old Tom, Distillery Inc.")).toBe("old tom distillery inc");
  });

  it("step 6: keeps an internal hyphen — a compound class/type stays one word pair", () => {
    expect(normalizeForFuzzyMatch("Kentucky-Straight Bourbon")).toBe("kentucky-straight bourbon");
  });

  it("step 6: a leading or trailing apostrophe/hyphen is not 'internal' and is dropped", () => {
    expect(normalizeForFuzzyMatch("-Test-")).toBe("test");
  });

  it("does not leave a doubled space where step 6 removed a punctuation mark between two words", () => {
    expect(normalizeForFuzzyMatch("Old , Tom")).toBe("old tom");
  });
});
