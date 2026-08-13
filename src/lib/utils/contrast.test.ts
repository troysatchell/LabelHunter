import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, relativeLuminance, WCAG_AA_TEXT, WCAG_AA_UI } from "./contrast";

describe("hexToRgb", () => {
  it("parses a 6-digit hex color into its RGB channels", () => {
    expect(hexToRgb("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb("#2383E2")).toEqual({ r: 35, g: 131, b: 226 });
  });

  it("rejects a value that is not a 6-digit hex color", () => {
    expect(() => hexToRgb("white")).toThrow();
    expect(() => hexToRgb("#FFF")).toThrow();
    expect(() => hexToRgb("2383E2")).toThrow();
  });
});

describe("relativeLuminance", () => {
  it("gives white the maximum luminance and black the minimum", () => {
    expect(relativeLuminance(hexToRgb("#FFFFFF"))).toBeCloseTo(1, 5);
    expect(relativeLuminance(hexToRgb("#000000"))).toBeCloseTo(0, 5);
  });
});

describe("contrastRatio", () => {
  it("gives black-on-white the maximum ratio, 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
  });

  it("gives a color against itself the minimum ratio, 1:1", () => {
    expect(contrastRatio("#37352F", "#37352F")).toBeCloseTo(1, 5);
  });

  it("is symmetric in argument order", () => {
    expect(contrastRatio("#37352F", "#FFFFFF")).toBeCloseTo(contrastRatio("#FFFFFF", "#37352F"), 10);
  });

  it("matches a known reference value (WCAG's own worked example: #767676 on white is exactly 4.54:1)", () => {
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });
});

describe("WCAG floor constants", () => {
  it("names the two floors this project checks against", () => {
    expect(WCAG_AA_TEXT).toBe(4.5);
    expect(WCAG_AA_UI).toBe(3.0);
  });
});
