import { describe, expect, it } from "vitest";
import { HaikuExtractionError, parseExtractionResponse } from "./response";
import { WELL_FORMED_EXTRACTION_BODY as WELL_FORMED_BODY, makeMockMessage as makeMessage } from "./test-support";

describe("parseExtractionResponse — well-formed response", () => {
  it("maps every field to the typed result", () => {
    const message = makeMessage(JSON.stringify(WELL_FORMED_BODY));
    const result = parseExtractionResponse(message);

    expect(result.image_quality).toEqual({ legible: "yes", issues: ["none"], confidence: 0.97 });
    expect(result.brand_name.value).toBe("Old Tom Distillery");
    expect(result.brand_name.evidence).toBe("OLD TOM DISTILLERY");
    expect(result.class_type.value).toBe("Straight Bourbon Whiskey");
    expect(result.alcohol_content.value).toBe("45% Alc./Vol. (90 Proof)");
    expect(result.net_contents.value).toBe("750 mL");
    expect(result.beverage_type.value).toBe("spirits");
    expect(result.government_warning.present).toBe(true);
    expect(result.government_warning.prefix_casing).toBe("ALL_CAPS");
    expect(result.government_warning.formatting.bold).toBe("uncertain");
    expect(result.government_warning.transcription).toBe(WELL_FORMED_BODY.government_warning.transcription);
  });

  it("maps a null value and empty evidence for an absent field, per extractor rule 4", () => {
    const body = {
      ...WELL_FORMED_BODY,
      net_contents: { value: null, evidence: "", confidence: 0.0, alternates: [] },
    };
    const message = makeMessage(JSON.stringify(body));
    const result = parseExtractionResponse(message);
    expect(result.net_contents.value).toBeNull();
    expect(result.net_contents.evidence).toBe("");
    expect(result.net_contents.confidence).toBe(0);
  });

  it("maps a non-empty alternates array, for a field the label states two ways", () => {
    const body = {
      ...WELL_FORMED_BODY,
      alcohol_content: {
        value: "45% Alc./Vol.",
        evidence: "45% Alc./Vol.",
        confidence: 0.8,
        alternates: ["45.5% Alc./Vol."],
      },
    };
    const message = makeMessage(JSON.stringify(body));
    const result = parseExtractionResponse(message);
    expect(result.alcohol_content.alternates).toEqual(["45.5% Alc./Vol."]);
  });

  it("maps a low-confidence, unclear read without treating it as an error (TH-R10)", () => {
    // Uncertain beats wrong: a low confidence value is a normal extraction
    // result. Only the Validation Router decides what to do about it.
    const body = {
      ...WELL_FORMED_BODY,
      brand_name: { value: "Old Tom Distillery", evidence: "OLD TOM DIST?LLERY", confidence: 0.12, alternates: [] },
      image_quality: { legible: "partial", issues: ["glare", "blur"], confidence: 0.2 },
    };
    const message = makeMessage(JSON.stringify(body));
    const result = parseExtractionResponse(message);
    expect(result.brand_name.confidence).toBe(0.12);
    expect(result.image_quality.legible).toBe("partial");
    expect(result.image_quality.issues).toEqual(["glare", "blur"]);
  });
});

describe("parseExtractionResponse — malformed responses fail loudly", () => {
  it("throws on a refused response instead of reading empty content", () => {
    const message = makeMessage("", { stop_reason: "refusal", content: [] });
    expect(() => parseExtractionResponse(message)).toThrow(HaikuExtractionError);
    expect(() => parseExtractionResponse(message)).toThrow(/refus/i);
  });

  it("throws on a response that stopped before end_turn", () => {
    const message = makeMessage(JSON.stringify(WELL_FORMED_BODY).slice(0, 20), {
      stop_reason: "max_tokens",
    });
    expect(() => parseExtractionResponse(message)).toThrow(HaikuExtractionError);
    expect(() => parseExtractionResponse(message)).toThrow(/max_tokens/);
  });

  it("throws when the response has no text content block", () => {
    const message = makeMessage("", { content: [] });
    expect(() => parseExtractionResponse(message)).toThrow(HaikuExtractionError);
    expect(() => parseExtractionResponse(message)).toThrow(/no text content block/);
  });

  it("throws when the response text is not valid JSON", () => {
    const message = makeMessage("{not json");
    expect(() => parseExtractionResponse(message)).toThrow(HaikuExtractionError);
    expect(() => parseExtractionResponse(message)).toThrow(/not valid JSON/);
  });

  it("throws when a required top-level field is missing", () => {
    const { net_contents: _dropped, ...withoutNetContents } = WELL_FORMED_BODY;
    const message = makeMessage(JSON.stringify(withoutNetContents));
    let error: unknown;
    try {
      parseExtractionResponse(message);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HaikuExtractionError);
    expect((error as HaikuExtractionError).problems.join("\n")).toMatch(/net_contents/);
  });

  it("throws when a field's confidence is the wrong type", () => {
    const body = {
      ...WELL_FORMED_BODY,
      brand_name: { ...WELL_FORMED_BODY.brand_name, confidence: "high" },
    };
    const message = makeMessage(JSON.stringify(body));
    let error: unknown;
    try {
      parseExtractionResponse(message);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HaikuExtractionError);
    expect((error as HaikuExtractionError).problems.join("\n")).toMatch(
      /brand_name\.confidence.*expected a number/,
    );
  });

  it("throws when image_quality.legible is not one of the enum values", () => {
    const body = { ...WELL_FORMED_BODY, image_quality: { ...WELL_FORMED_BODY.image_quality, legible: "maybe" } };
    const message = makeMessage(JSON.stringify(body));
    let error: unknown;
    try {
      parseExtractionResponse(message);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HaikuExtractionError);
    expect((error as HaikuExtractionError).problems.join("\n")).toMatch(
      /image_quality\.legible.*expected one of yes, partial, no/,
    );
  });

  it("throws when government_warning.prefix_casing is not one of the enum values", () => {
    const body = {
      ...WELL_FORMED_BODY,
      government_warning: { ...WELL_FORMED_BODY.government_warning, prefix_casing: "lowercase" },
    };
    const message = makeMessage(JSON.stringify(body));
    expect(() => parseExtractionResponse(message)).toThrow(/prefix_casing/);
  });

  it("collects every problem in one pass, not just the first", () => {
    const body = {
      ...WELL_FORMED_BODY,
      brand_name: { ...WELL_FORMED_BODY.brand_name, confidence: "high" },
      net_contents: { ...WELL_FORMED_BODY.net_contents, evidence: 42 },
    };
    const message = makeMessage(JSON.stringify(body));
    let error: unknown;
    try {
      parseExtractionResponse(message);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HaikuExtractionError);
    const problems = (error as HaikuExtractionError).problems;
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join("\n")).toMatch(/brand_name\.confidence/);
    expect(problems.join("\n")).toMatch(/net_contents\.evidence/);
  });
});
