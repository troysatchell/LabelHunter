import { describe, expect, it } from "vitest";
import { scoreExtraction } from "./extraction-scoring";
import { testExtraction, testField, testGoldenCase } from "./test-support";

describe("scoreExtraction", () => {
  it("scores every field correct on a clean, exact match", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction());
    expect(result.fields.every((f) => f.correct)).toBe(true);
    expect(result.fields.map((f) => f.field)).toEqual(["brandName", "classType", "abv", "netContents", "governmentWarning"]);
  });

  it("brandName: scores correct through a case/punctuation difference (STONE'S THROW, TH-R8)", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      label: { ...base.label, brandName: "STONE'S THROW" },
      application: { ...base.application, brandName: "Stone's Throw" },
    });
    const result = scoreExtraction(caseSpec, testExtraction({ brand_name: testField("STONE'S THROW") }));
    expect(result.fields.find((f) => f.field === "brandName")?.correct).toBe(true);
  });

  it("brandName: scores incorrect when Haiku reads a different brand", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction({ brand_name: testField("Copper Kettle Spirits") }));
    const score = result.fields.find((f) => f.field === "brandName");
    expect(score?.correct).toBe(false);
    expect(score?.detail).toContain("Copper Kettle Spirits");
  });

  it("brandName: scores incorrect when Haiku reads nothing", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction({ brand_name: testField(null) }));
    expect(result.fields.find((f) => f.field === "brandName")?.correct).toBe(false);
  });

  it("classType: scores correct through a case difference", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction({ class_type: testField("straight bourbon whiskey") }));
    expect(result.fields.find((f) => f.field === "classType")?.correct).toBe(true);
  });

  it("classType: scores incorrect when Haiku reads a different class/type", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction({ class_type: testField("Vodka") }));
    const score = result.fields.find((f) => f.field === "classType");
    expect(score?.correct).toBe(false);
    expect(score?.actual).toBe("Vodka");
  });

  it("abv: scores correct when the parsed percent matches, even with different printed text", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction({ alcohol_content: testField("90 Proof (45% Alc./Vol.)") }));
    expect(result.fields.find((f) => f.field === "abv")?.correct).toBe(true);
  });

  it("abv: scores incorrect when the parsed percent disagrees", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction({ alcohol_content: testField("40% Alc./Vol. (80 Proof)") }));
    const score = result.fields.find((f) => f.field === "abv");
    expect(score?.correct).toBe(false);
    expect(score?.actual).toBe("40%");
  });

  it("abv: scores correct when the label has no ABV and Haiku reads none", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      label: { ...base.label, abvPresent: false, abvText: "", abvPercent: undefined },
    });
    const result = scoreExtraction(caseSpec, testExtraction({ alcohol_content: testField(null) }));
    expect(result.fields.find((f) => f.field === "abv")?.correct).toBe(true);
  });

  it("abv: scores incorrect when the label has no ABV but Haiku reads one anyway", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      label: { ...base.label, abvPresent: false, abvText: "", abvPercent: undefined },
    });
    const result = scoreExtraction(caseSpec, testExtraction({ alcohol_content: testField("5% Alc./Vol.") }));
    expect(result.fields.find((f) => f.field === "abv")?.correct).toBe(false);
  });

  it("netContents: scores correct on a unit restated in a different but equivalent form", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction({ net_contents: testField("0.75 L") }));
    expect(result.fields.find((f) => f.field === "netContents")?.correct).toBe(true);
  });

  it("netContents: scores incorrect when the value disagrees", () => {
    const result = scoreExtraction(testGoldenCase(), testExtraction({ net_contents: testField("375 mL") }));
    expect(result.fields.find((f) => f.field === "netContents")?.correct).toBe(false);
  });

  it("governmentWarning: scores correct when the transcription matches after transport normalization only", () => {
    const base = testExtraction();
    const withWrapping = testExtraction({
      government_warning: {
        ...base.government_warning,
        transcription: base.government_warning.transcription!.replace(" (2) ", "\n(2) "),
      },
    });
    const result = scoreExtraction(testGoldenCase(), withWrapping);
    expect(result.fields.find((f) => f.field === "governmentWarning")?.correct).toBe(true);
  });

  it("governmentWarning: scores incorrect when the transcription is reworded, even though it's still 'present'", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      label: {
        ...base.label,
        governmentWarningText:
          "GOVERNMENT WARNING: (1) According to the Surgeon General, pregnant women should not consume alcoholic beverages due to the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
      },
    });
    const result = scoreExtraction(caseSpec, testExtraction());
    expect(result.fields.find((f) => f.field === "governmentWarning")?.correct).toBe(false);
  });

  it("governmentWarning: scores correct when both agree the warning is absent", () => {
    const base = testGoldenCase();
    const caseSpec = testGoldenCase({
      label: { ...base.label, governmentWarningPresent: false, governmentWarningText: "" },
    });
    const result = scoreExtraction(
      caseSpec,
      testExtraction({
        government_warning: {
          present: false,
          transcription: null,
          prefix_casing: "NOT_VISIBLE",
          formatting: { bold: "false" },
          evidence: "",
          confidence: 0.9,
        },
      }),
    );
    expect(result.fields.find((f) => f.field === "governmentWarning")?.correct).toBe(true);
  });

  it("governmentWarning: scores incorrect when the label has a warning but Haiku reads none", () => {
    const result = scoreExtraction(
      testGoldenCase(),
      testExtraction({
        government_warning: {
          present: false,
          transcription: null,
          prefix_casing: "NOT_VISIBLE",
          formatting: { bold: "false" },
          evidence: "",
          confidence: 0.5,
        },
      }),
    );
    expect(result.fields.find((f) => f.field === "governmentWarning")?.correct).toBe(false);
  });
});
