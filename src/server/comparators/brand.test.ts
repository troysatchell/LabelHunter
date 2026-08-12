/**
 * Tests for the real brand/class-type comparator (LH-013 / TRO-463, CP-1
 * §5.3 `AMBIGUOUS_BRAND`, TH-R8). Written before `brand.ts`'s
 * implementation — TDD, PRD §6.
 *
 * TH-R8's flagship case: "the brand name was 'STONE'S THROW' on the label
 * but 'Stone's Throw' in the application ... it's obviously the same
 * thing" (Dave Morrison, quoted in `audit/requirements/inventory.md`).
 * `case-14-case-variant-brand-stones-throw` in the golden set is this
 * ticket's named ground truth for this comparator (see the batch brief).
 */
import { describe, expect, it } from "vitest";
import type { ExtractedField } from "../extractor/types";
import { compareBrandOrClass } from "./brand";

const CONTEXT = { beverageType: "spirits" as const };

function field(value: string | null, overrides: Partial<ExtractedField> = {}): ExtractedField {
  return { value, evidence: value ?? "", confidence: 0.95, alternates: [], ...overrides };
}

describe("compareBrandOrClass — TH-R8's named case", () => {
  it("MATCHES 'STONE'S THROW' (label) against 'Stone's Throw' (application), with a note", () => {
    const result = compareBrandOrClass(field("STONE'S THROW"), "Stone's Throw", CONTEXT);
    expect(result.verdict).toBe("MATCH");
    expect(result.note).toBeTruthy(); // PRD §3.3: judgment carries an explanation, not a silent pass.
  });

  it("adds no note when the raw strings are already identical — nothing to explain", () => {
    const result = compareBrandOrClass(field("Stone's Throw"), "Stone's Throw", CONTEXT);
    expect(result.verdict).toBe("MATCH");
    expect(result.note).toBeUndefined();
  });

  it("MATCHes 'STONES THROW' (label, no apostrophe) against 'Stone's Throw' (application) — case-15, TRO-536", () => {
    // case-15-case-variant-brand-punctuation: the label prints no apostrophe
    // at all. Step 6 of the normalizer now drops the apostrophe along with
    // every other punctuation mark, so both sides fold to "stones throw".
    const result = compareBrandOrClass(field("STONES THROW"), "Stone's Throw", CONTEXT);
    expect(result.verdict).toBe("MATCH");
  });
});

describe("compareBrandOrClass — CP-1 §5.3's threshold table", () => {
  it("MATCHes case/punctuation/whitespace variants of the same value", () => {
    expect(compareBrandOrClass(field("stone's throw"), "STONE'S THROW", CONTEXT).verdict).toBe("MATCH");
    expect(compareBrandOrClass(field("  Stone's Throw  "), "Stone's Throw", CONTEXT).verdict).toBe("MATCH");
  });

  it("NEEDS_REVIEW, never MISMATCH, for a genuinely different value (PRD §3.3: never silent FAIL)", () => {
    const result = compareBrandOrClass(field("Northwind Cellars"), "Stone's Throw", CONTEXT);
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.note).toBeTruthy();
  });

  it("NEEDS_REVIEW for a label that adds real words beyond a formatting difference", () => {
    // Golden-set case-16: brand adds words the application never filed.
    const result = compareBrandOrClass(field("Stones Throw Distillery Co."), "Stone's Throw", CONTEXT);
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("NEEDS_REVIEW when there is no label value to compare", () => {
    const result = compareBrandOrClass(field(null), "Stone's Throw", CONTEXT);
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("NEEDS_REVIEW when both values normalize to an empty string — not a false MATCH (CodeRabbit finding)", () => {
    // "..." and "---" both reduce to "" once punctuation is dropped
    // (normalize.ts step 6). Two empty strings score 1.0 similarity
    // (similarity.ts treats "nothing to disagree about" as identical) —
    // without this guard, two garbage/punctuation-only reads would MATCH.
    const result = compareBrandOrClass(field("..."), "---", CONTEXT);
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("never returns MISMATCH — brand/class equivalence is TH-R8's judgment regime, not TH-R9's exact one", () => {
    const cases: Array<[string, string]> = [
      ["Stone's Throw", "Stone's Throw"],
      ["Northwind Cellars", "Stone's Throw"],
      ["", "Stone's Throw"],
      ["A completely unrelated distillery name", "Stone's Throw"],
    ];
    for (const [label, application] of cases) {
      expect(compareBrandOrClass(field(label), application, CONTEXT).verdict).not.toBe("MISMATCH");
    }
  });
});

describe("compareBrandOrClass — class/type uses the same rule (CP-1 §5.3: 'the same rule applies to class_type')", () => {
  it("MATCHes a case-only difference in a class/type designation", () => {
    const result = compareBrandOrClass(field("STRAIGHT BOURBON WHISKEY"), "Straight Bourbon Whiskey", CONTEXT);
    expect(result.verdict).toBe("MATCH");
  });
});

describe("compareBrandOrClass — German ß case-folding (TRO-504 item 2)", () => {
  it("MATCHes an all-caps ß-less spelling against its mixed-case ß spelling", () => {
    const result = compareBrandOrClass(field("WEISSBIER HAUS"), "Weißbier Haus", CONTEXT);
    expect(result.verdict).toBe("MATCH");
  });
});
