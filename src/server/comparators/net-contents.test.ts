/**
 * Tests for the real net-contents grammar and comparator (LH-013 / TRO-463,
 * CP-1 §5.3 `AMBIGUOUS_NET_CONTENTS`, TH-R11). Written before
 * `net-contents.ts`'s implementation — TDD, PRD §6.
 *
 * TRO-504 item 3 is this file's named regression: `provisionalParseNetContents`
 * stopped at the first unsupported unit instead of scanning past it, so
 * `"90 Proof 750 mL"` returned `null` instead of finding `750 mL`.
 */
import { describe, expect, it } from "vitest";
import type { ExtractedField } from "../extractor/types";
import { compareNetContents, convertNetContentsToMl, normalizeNetContentsUnit, parseNetContents } from "./net-contents";

function field(value: string | null, overrides: Partial<ExtractedField> = {}): ExtractedField {
  return { value, evidence: value ?? "", confidence: 0.95, alternates: [], ...overrides };
}
const CONTEXT = { beverageType: "spirits" as const };

describe("parseNetContents — clean reads", () => {
  it("reads a value and a unit from clean text", () => {
    expect(parseNetContents("750 mL")).toEqual({ value: 750, unit: "ml" });
    expect(parseNetContents("1 L")).toEqual({ value: 1, unit: "l" });
    expect(parseNetContents("12 fl oz")).toEqual({ value: 12, unit: "fl oz" });
  });

  it("returns null when no number is present, or the unit is outside the accepted set", () => {
    expect(parseNetContents("a lot")).toBeNull();
    expect(parseNetContents("12 lb")).toBeNull();
  });
});

describe("parseNetContents — TRO-504 item 3: scans past a leading number with no recognized unit", () => {
  it("finds '750 mL' past the leading '90 Proof' text — the named regression case", () => {
    expect(parseNetContents("90 Proof 750 mL")).toEqual({ value: 750, unit: "ml" });
  });

  it("still finds the value when the unsupported leading number is itself unit-less", () => {
    expect(parseNetContents("Batch 12 — 375 mL")).toEqual({ value: 375, unit: "ml" });
  });

  it("returns null when NO candidate number has a recognized unit", () => {
    expect(parseNetContents("90 Proof 12 Batches")).toBeNull();
  });
});

describe("parseNetContents — does not stop at the unit when evidence runs two fields together", () => {
  it("does not glue trailing text onto the unit", () => {
    expect(parseNetContents("750 mL Alcohol 45%")).toEqual({ value: 750, unit: "ml" });
    expect(parseNetContents("1 L Net Contents")).toEqual({ value: 1, unit: "l" });
  });

  it("does not let a longer unit's prefix falsely match a shorter one", () => {
    expect(parseNetContents("1 Liter Bottle")).toEqual({ value: 1, unit: "l" });
  });
});

describe("convertNetContentsToMl", () => {
  it("converts L and fl oz to mL", () => {
    expect(convertNetContentsToMl({ value: 750, unit: "ml" })).toBe(750);
    expect(convertNetContentsToMl({ value: 0.75, unit: "l" })).toBe(750);
    expect(convertNetContentsToMl({ value: 1, unit: "fl oz" })).toBeCloseTo(29.5735, 4);
  });
});

describe("normalizeNetContentsUnit", () => {
  it("normalizes a free-typed application unit to the accepted set", () => {
    expect(normalizeNetContentsUnit("mL")).toBe("ml");
    expect(normalizeNetContentsUnit("Liters")).toBe("l");
    expect(normalizeNetContentsUnit("fl. oz.")).toBe("fl oz");
  });

  it("returns null for a unit outside the accepted set", () => {
    expect(normalizeNetContentsUnit("gal")).toBeNull();
  });
});

describe("compareNetContents — MATCH/MISMATCH against the application's declared value", () => {
  it("MATCHes an identical value and unit", () => {
    expect(compareNetContents(field("750 mL"), "750 mL", CONTEXT).verdict).toBe("MATCH");
  });

  it("MATCHes formatting variants — '750ml', '750 mL', '750 ML' all normalize the same (TH-R8's principle, applied to a numeric field)", () => {
    for (const text of ["750ml", "750 mL", "750 ML"]) {
      expect(compareNetContents(field(text), "750 mL", CONTEXT).verdict).toBe("MATCH");
    }
  });

  it("MATCHes the same quantity stated in a different, convertible unit", () => {
    expect(compareNetContents(field("0.75 L"), "750 mL", CONTEXT).verdict).toBe("MATCH");
  });

  it("MISMATCHes a materially different quantity (golden-set case-27)", () => {
    const result = compareNetContents(field("22 FL OZ"), "12 fl oz", CONTEXT);
    expect(result.verdict).toBe("MISMATCH");
  });

  it("NEEDS_REVIEW when the label value does not parse", () => {
    expect(compareNetContents(field("a lot"), "750 mL", CONTEXT).verdict).toBe("NEEDS_REVIEW");
  });

  it("NEEDS_REVIEW when there is no label value to compare", () => {
    expect(compareNetContents(field(null), "750 mL", CONTEXT).verdict).toBe("NEEDS_REVIEW");
  });
});
