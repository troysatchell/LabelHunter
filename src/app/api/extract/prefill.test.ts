import { describe, expect, it } from "vitest";
import type { ExtractedField, HaikuExtractionResult } from "../../../server/extractor/types";
import { mapExtractionToPrefill, UNREADABLE_MESSAGE } from "./prefill";

function field(value: string | null): ExtractedField {
  return { value, evidence: value ?? "", confidence: 0.9, alternates: [] };
}

function extraction(overrides: Partial<HaikuExtractionResult> = {}): HaikuExtractionResult {
  return {
    image_quality: { legible: "yes", issues: [], confidence: 0.95 },
    brand_name: field("OLD TOM DISTILLERY"),
    class_type: field("Kentucky Straight Bourbon Whiskey"),
    alcohol_content: field("45% Alc./Vol. (90 Proof)"),
    net_contents: field("750 mL"),
    beverage_type: field("spirits"),
    government_warning: {
      present: true,
      transcription: null,
      prefix_casing: "ALL_CAPS",
      formatting: { bold: "true" },
      evidence: "",
      confidence: 0.9,
    },
    ...overrides,
  };
}

describe("mapExtractionToPrefill", () => {
  it("maps a full readable label to all five form values", () => {
    const result = mapExtractionToPrefill(extraction());
    expect(result).toEqual({
      outcome: "prefill",
      message: null,
      fields: {
        beverageType: "spirits",
        brandName: "OLD TOM DISTILLERY",
        classType: "Kentucky Straight Bourbon Whiskey",
        alcoholContentPercent: 45,
        netContentsValue: 750,
        netContentsUnit: "mL",
      },
    });
  });

  it("returns the unreadable outcome, with every field null, when the extractor judged the photo illegible", () => {
    const result = mapExtractionToPrefill(
      extraction({ image_quality: { legible: "no", issues: ["blur"], confidence: 0.8 } }),
    );
    expect(result.outcome).toBe("unreadable");
    expect(result.message).toBe(UNREADABLE_MESSAGE);
    expect(Object.values(result.fields).every((v) => v === null)).toBe(true);
  });

  it("still prefills what it read when legibility is only partial", () => {
    const result = mapExtractionToPrefill(
      extraction({
        image_quality: { legible: "partial", issues: ["glare"], confidence: 0.6 },
        class_type: field(null),
      }),
    );
    expect(result.outcome).toBe("prefill");
    expect(result.fields.brandName).toBe("OLD TOM DISTILLERY");
    expect(result.fields.classType).toBeNull();
  });

  it("halves a proof-only ABV statement, the comparator's own 27 CFR 5.1 arithmetic", () => {
    const result = mapExtractionToPrefill(extraction({ alcohol_content: field("90 Proof") }));
    expect(result.fields.alcoholContentPercent).toBe(45);
  });

  it("drops an out-of-range ABV instead of clamping it — a misread must not look plausible", () => {
    const result = mapExtractionToPrefill(extraction({ alcohol_content: field("450%") }));
    expect(result.fields.alcoholContentPercent).toBeNull();
  });

  it("parses fluid-ounce net contents to the form's own unit spelling", () => {
    const result = mapExtractionToPrefill(extraction({ net_contents: field("12 FL OZ") }));
    expect(result.fields.netContentsValue).toBe(12);
    expect(result.fields.netContentsUnit).toBe("fl oz");
  });

  it("prefills neither half of net contents when the unit is unrecognized — half a quantity is worse than none", () => {
    const result = mapExtractionToPrefill(extraction({ net_contents: field("2 magnums") }));
    expect(result.fields.netContentsValue).toBeNull();
    expect(result.fields.netContentsUnit).toBeNull();
  });

  it("never picks a beverage radio from a reading outside the three real options", () => {
    const result = mapExtractionToPrefill(extraction({ beverage_type: field("sparkling wine") }));
    expect(result.fields.beverageType).toBeNull();
  });

  it("accepts a beverage reading regardless of case", () => {
    const result = mapExtractionToPrefill(extraction({ beverage_type: field("Spirits") }));
    expect(result.fields.beverageType).toBe("spirits");
  });

  it("turns whitespace-only readings into null, not empty prefills", () => {
    const result = mapExtractionToPrefill(extraction({ brand_name: field("   ") }));
    expect(result.fields.brandName).toBeNull();
  });
});
