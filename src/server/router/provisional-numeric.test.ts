import { describe, expect, it } from "vitest";
import {
  convertNetContentsToMl,
  normalizeProvisionalUnit,
  provisionalParseAbv,
  provisionalParseNetContents,
} from "./provisional-numeric";

describe("provisionalParseAbv", () => {
  it("reads a percent and a proof out of CP-1's own worked example", () => {
    expect(provisionalParseAbv("45% Alc./Vol. (90 Proof)")).toEqual({ percent: 45, proof: 90 });
  });

  it("returns null for whichever pattern is absent", () => {
    expect(provisionalParseAbv("45% Alc./Vol.")).toEqual({ percent: 45, proof: null });
    expect(provisionalParseAbv("90 Proof")).toEqual({ percent: null, proof: 90 });
  });

  it("returns both null for text with neither pattern", () => {
    expect(provisionalParseAbv("Straight Bourbon Whiskey")).toEqual({ percent: null, proof: null });
  });
});

describe("provisionalParseNetContents", () => {
  it("reads a value and a unit from clean text", () => {
    expect(provisionalParseNetContents("750 mL")).toEqual({ value: 750, unit: "ml" });
    expect(provisionalParseNetContents("1 L")).toEqual({ value: 1, unit: "l" });
    expect(provisionalParseNetContents("12 fl oz")).toEqual({ value: 12, unit: "fl oz" });
  });

  it("does not stop at the unit — trailing text in the same evidence string does not break the parse", () => {
    // The regression case: an earlier version of this parser captured
    // everything after the number up to the next digit, so "Alcohol"
    // ended up glued onto the candidate unit text ("ml alcohol"), which
    // then matched no known unit and the whole read failed. Real evidence
    // strings often run two fields' text together.
    expect(provisionalParseNetContents("750 mL Alcohol 45%")).toEqual({ value: 750, unit: "ml" });
    expect(provisionalParseNetContents("1 L Net Contents")).toEqual({ value: 1, unit: "l" });
  });

  it("does not let a longer unit's prefix falsely match a shorter one", () => {
    expect(provisionalParseNetContents("1 Liter Bottle")).toEqual({ value: 1, unit: "l" });
  });

  it("returns null when no number is present", () => {
    expect(provisionalParseNetContents("a lot")).toBeNull();
  });

  it("returns null when the unit is outside the accepted stand-in set", () => {
    expect(provisionalParseNetContents("12 lb")).toBeNull();
  });
});

describe("convertNetContentsToMl", () => {
  it("converts L and fl oz to mL", () => {
    expect(convertNetContentsToMl({ value: 750, unit: "ml" })).toBe(750);
    expect(convertNetContentsToMl({ value: 0.75, unit: "l" })).toBe(750);
    expect(convertNetContentsToMl({ value: 1, unit: "fl oz" })).toBeCloseTo(29.5735, 4);
  });
});

describe("normalizeProvisionalUnit", () => {
  it("normalizes a free-typed application unit to the stand-in set", () => {
    expect(normalizeProvisionalUnit("mL")).toBe("ml");
    expect(normalizeProvisionalUnit("Liters")).toBe("l");
    expect(normalizeProvisionalUnit("fl. oz.")).toBe("fl oz");
  });

  it("returns null for a unit outside the stand-in set", () => {
    expect(normalizeProvisionalUnit("gal")).toBeNull();
  });
});
