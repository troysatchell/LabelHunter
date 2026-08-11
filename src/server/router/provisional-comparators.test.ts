import { describe, expect, it } from "vitest";
import {
  PROVISIONAL_FIELD_COMPARATORS,
  provisionalAbvComparator,
  provisionalNetContentsComparator,
  provisionalTextComparator,
} from "./provisional-comparators";
import type { ExtractedField } from "../extractor/types";

function field(value: string | null, overrides: Partial<ExtractedField> = {}): ExtractedField {
  return { value, evidence: value ?? "", confidence: 0.9, alternates: [], ...overrides };
}

describe("provisionalTextComparator", () => {
  it("matches on exact text after a trim and a casefold", () => {
    const result = provisionalTextComparator(field("Old Tom Distillery"), "  old tom distillery  ", { beverageType: "spirits" });
    expect(result.verdict).toBe("MATCH");
  });

  it("matches a case-only difference (TH-R8's STONE'S THROW example, straight apostrophe both sides)", () => {
    const result = provisionalTextComparator(field("STONE'S THROW"), "Stone's Throw", { beverageType: "spirits" });
    expect(result.verdict).toBe("MATCH");
  });

  it("does NOT fold a curly apostrophe against a straight one — needs REVIEW, not MATCH", () => {
    // Documents this comparator's own limitation (the file comment): real
    // apostrophe folding is exactly what LH-013's real fuzzy matcher adds.
    const result = provisionalTextComparator(field("Stone’s Throw"), "Stone's Throw", { beverageType: "spirits" });
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("never returns MISMATCH — PRD §3.3: distance beyond threshold routes to REVIEW, not a silent FAIL", () => {
    const result = provisionalTextComparator(field("Totally Different Brand"), "Old Tom Distillery", {
      beverageType: "spirits",
    });
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("needs review when the label has no value to compare", () => {
    const result = provisionalTextComparator(field(null), "Old Tom Distillery", { beverageType: "spirits" });
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.note).toMatch(/no label value/i);
  });
});

describe("provisionalAbvComparator", () => {
  it("matches when the parsed label percent equals the application percent", () => {
    const result = provisionalAbvComparator(field("45% Alc./Vol. (90 Proof)"), 45, { beverageType: "spirits" });
    expect(result.verdict).toBe("MATCH");
  });

  it("needs review when the percents differ", () => {
    const result = provisionalAbvComparator(field("40% Alc./Vol."), 45, { beverageType: "spirits" });
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("needs review when the label text does not parse to a percent", () => {
    const result = provisionalAbvComparator(field("strong"), 45, { beverageType: "spirits" });
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.note).toMatch(/could not parse/i);
  });
});

describe("provisionalNetContentsComparator", () => {
  it("matches equal values expressed in the same unit", () => {
    const result = provisionalNetContentsComparator(field("750 mL"), "750 mL", { beverageType: "spirits" });
    expect(result.verdict).toBe("MATCH");
  });

  it("matches equal quantities across recognized units (750 mL vs 0.75 L)", () => {
    const result = provisionalNetContentsComparator(field("750 mL"), "0.75 L", { beverageType: "spirits" });
    expect(result.verdict).toBe("MATCH");
  });

  it("needs review when the quantities differ", () => {
    const result = provisionalNetContentsComparator(field("750 mL"), "375 mL", { beverageType: "spirits" });
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });
});

describe("PROVISIONAL_FIELD_COMPARATORS", () => {
  it("wires the text comparator to both brand_name and class_type", () => {
    expect(PROVISIONAL_FIELD_COMPARATORS.brand_name).toBe(provisionalTextComparator);
    expect(PROVISIONAL_FIELD_COMPARATORS.class_type).toBe(provisionalTextComparator);
  });

  it("wires the numeric comparators to alcohol_content and net_contents", () => {
    expect(PROVISIONAL_FIELD_COMPARATORS.alcohol_content).toBe(provisionalAbvComparator);
    expect(PROVISIONAL_FIELD_COMPARATORS.net_contents).toBe(provisionalNetContentsComparator);
  });
});
