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
    expect(normalizeForFuzzyMatch("STONE'S THROW")).toBe("stones throw");
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
    expect(normalizeForFuzzyMatch("  Stone's   Throw  ")).toBe("stones throw");
  });

  it("step 6 (punctuation): drops punctuation, including apostrophes, other than an internal hyphen", () => {
    expect(normalizeForFuzzyMatch("Old Tom, Distillery Inc.")).toBe("old tom distillery inc");
  });

  it("step 6: TRO-536, case-15 — a label with no apostrophe normalizes the same as an application that has one", () => {
    // case-15-case-variant-brand-punctuation: label "STONES THROW", application
    // "Stone's Throw". Before TRO-536 these normalized to "stones throw" and
    // "stone's throw" — one character apart, 0.923077 similarity, just under
    // the 0.95 MATCH threshold. Step 6 now drops the apostrophe too.
    expect(normalizeForFuzzyMatch("STONES THROW")).toBe(normalizeForFuzzyMatch("Stone's Throw"));
    expect(normalizeForFuzzyMatch("STONES THROW")).toBe("stones throw");
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

describe("normalizeForFuzzyMatch — the typographic right single quote, a gap TRO-536 closed", () => {
  it("normalizes U+2019 (’) to the same result as the straight apostrophe (') — case-15, TRO-536", () => {
    // CP-1 §5.3's step 3 names exactly three variants to fold: the straight
    // apostrophe, the backtick, and the acute accent. U+2019 RIGHT SINGLE
    // QUOTATION MARK — a stylized apostrophe a real vision-model extraction
    // may emit — is still not one of them, so step 3 still does not touch
    // it (lesson 15: implement the quoted rule as written, not a widened
    // paraphrase).
    // Before TRO-536 that left a real gap. Step 6 dropped U+2019 as
    // ordinary punctuation but kept the straight apostrophe. The two
    // readings normalized to different strings and scored ~0.923
    // similarity (see `brand.ts`'s 0.95 threshold) — just below MATCH.
    // TRO-536 closed the gap from the other side: step 6 now drops the
    // straight apostrophe too, so both readings converge on one string.
    const withCurlyApostrophe = normalizeForFuzzyMatch("Stone’s Throw");
    const withStraightApostrophe = normalizeForFuzzyMatch("Stone's Throw");
    expect(withCurlyApostrophe).toBe(withStraightApostrophe);
    expect(withCurlyApostrophe).toBe("stones throw"); // the curly mark is dropped as ordinary punctuation, not folded
  });
});
