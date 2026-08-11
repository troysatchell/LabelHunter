import { describe, expect, it } from "vitest";
import { parseVerifyFormData } from "./parse-request";

function baseFormData(overrides: Record<string, string | File | undefined> = {}): FormData {
  const fd = new FormData();
  const fields: Record<string, string | File> = {
    image: new File(["fake-bytes"], "label.jpg", { type: "image/jpeg" }),
    beverageType: "spirits",
    brandName: "Old Tom Distillery",
    classType: "Straight Bourbon Whiskey",
    alcoholContentPercent: "45",
    netContentsValue: "750",
    netContentsUnit: "mL",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    fd.set(key, value);
  }
  return fd;
}

describe("parseVerifyFormData — the happy path", () => {
  it("parses a complete, well-formed submission", () => {
    const result = parseVerifyFormData(baseFormData());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toMatchObject({
      beverageType: "spirits",
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
    expect(result.value.imageFile).toBeInstanceOf(File);
  });

  it("trims whitespace from text fields", () => {
    const result = parseVerifyFormData(baseFormData({ brandName: "  Old Tom Distillery  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.brandName).toBe("Old Tom Distillery");
  });

  it("allows alcoholContentPercent to be blank — legal for beer/wine (PRD §2)", () => {
    const result = parseVerifyFormData(baseFormData({ beverageType: "beer", alcoholContentPercent: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.alcoholContentPercent).toBeNull();
  });
});

describe("parseVerifyFormData — rejections carry a specific, human-readable message", () => {
  it("rejects a submission with no image", () => {
    const fd = baseFormData();
    fd.delete("image");
    const result = parseVerifyFormData(fd);
    expect(result).toEqual({ ok: false, message: "Add a label photo before you verify." });
  });

  it("rejects an empty image file", () => {
    const result = parseVerifyFormData(baseFormData({ image: new File([], "empty.jpg", { type: "image/jpeg" }) }));
    expect(result).toEqual({ ok: false, message: "Add a label photo before you verify." });
  });

  it("rejects a missing or invalid beverage type", () => {
    expect(parseVerifyFormData(baseFormData({ beverageType: "" }))).toEqual({
      ok: false,
      message: "Choose a beverage type: beer, wine, or spirits.",
    });
    expect(parseVerifyFormData(baseFormData({ beverageType: "mead" }))).toEqual({
      ok: false,
      message: "Choose a beverage type: beer, wine, or spirits.",
    });
  });

  it("rejects a blank brand name", () => {
    expect(parseVerifyFormData(baseFormData({ brandName: "   " }))).toEqual({
      ok: false,
      message: "Enter the brand name.",
    });
  });

  it("rejects a blank class/type", () => {
    expect(parseVerifyFormData(baseFormData({ classType: "" }))).toEqual({
      ok: false,
      message: "Enter the class or type.",
    });
  });

  it("rejects a non-numeric alcohol content", () => {
    expect(parseVerifyFormData(baseFormData({ alcoholContentPercent: "strong" }))).toEqual({
      ok: false,
      message: "Enter a number for alcohol content, or leave it blank.",
    });
  });

  it("rejects an alcohol content outside 0-100", () => {
    expect(parseVerifyFormData(baseFormData({ alcoholContentPercent: "150" }))).toEqual({
      ok: false,
      message: "Enter an alcohol content between 0 and 100, or leave it blank.",
    });
    expect(parseVerifyFormData(baseFormData({ alcoholContentPercent: "-5" }))).toEqual({
      ok: false,
      message: "Enter an alcohol content between 0 and 100, or leave it blank.",
    });
  });

  it("rejects a missing, non-numeric, or non-positive net contents value", () => {
    const fd = baseFormData();
    fd.delete("netContentsValue");
    expect(parseVerifyFormData(fd)).toEqual({
      ok: false,
      message: "Enter a net contents amount greater than zero.",
    });
    expect(parseVerifyFormData(baseFormData({ netContentsValue: "0" }))).toEqual({
      ok: false,
      message: "Enter a net contents amount greater than zero.",
    });
    expect(parseVerifyFormData(baseFormData({ netContentsValue: "not-a-number" }))).toEqual({
      ok: false,
      message: "Enter a net contents amount greater than zero.",
    });
  });

  it("rejects a net contents unit outside the recognized set", () => {
    expect(parseVerifyFormData(baseFormData({ netContentsUnit: "gallons" }))).toEqual({
      ok: false,
      message: "Choose a net contents unit: mL, L, or fl oz.",
    });
  });
});
