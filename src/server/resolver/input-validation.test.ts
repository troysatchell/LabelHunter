import { describe, expect, it } from "vitest";
import {
  LONG_FIELD_MAX_LENGTH,
  ResolverInputError,
  SHORT_FIELD_MAX_LENGTH,
  assertUntrustedInputWithinBounds,
} from "./input-validation";
import { makeResolverApplication, makeResolverInput } from "./test-support";

function baseInput() {
  const input = makeResolverInput();
  return { application: input.application, extraction: input.extraction };
}

describe("assertUntrustedInputWithinBounds", () => {
  it("passes a well-formed application and extraction", () => {
    expect(() => assertUntrustedInputWithinBounds(baseInput())).not.toThrow();
  });

  it("rejects an implausibly long brand name — a length signal independent of content (CP-1 §6.3)", () => {
    const input = baseInput();
    input.application = makeResolverApplication({ brandName: "A".repeat(SHORT_FIELD_MAX_LENGTH + 1) });
    expect(() => assertUntrustedInputWithinBounds(input)).toThrow(ResolverInputError);
    expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/application\.brandName/);
  });

  it("accepts a brand name exactly at the ceiling", () => {
    const input = baseInput();
    input.application = makeResolverApplication({ brandName: "A".repeat(SHORT_FIELD_MAX_LENGTH) });
    expect(() => assertUntrustedInputWithinBounds(input)).not.toThrow();
  });

  it("rejects an implausibly long extracted field value", () => {
    const input = baseInput();
    input.extraction = {
      ...input.extraction,
      brand_name: { value: "B".repeat(SHORT_FIELD_MAX_LENGTH + 1), evidence: "x", confidence: 0.9, alternates: [] },
    };
    expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.brand_name\.value/);
  });

  it("rejects an implausibly long alternates entry", () => {
    const input = baseInput();
    input.extraction = {
      ...input.extraction,
      alcohol_content: {
        value: "45%",
        evidence: "45%",
        confidence: 0.9,
        alternates: ["C".repeat(SHORT_FIELD_MAX_LENGTH + 1)],
      },
    };
    expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.alcohol_content\.alternates\[0\]/);
  });

  it("allows a government-warning transcription well past the short-field ceiling", () => {
    const input = baseInput();
    const longWarning = "GOVERNMENT WARNING: ".padEnd(SHORT_FIELD_MAX_LENGTH + 200, "x");
    input.extraction = {
      ...input.extraction,
      government_warning: { ...input.extraction.government_warning, transcription: longWarning, evidence: longWarning },
    };
    expect(() => assertUntrustedInputWithinBounds(input)).not.toThrow();
  });

  it("still rejects a government-warning transcription past its own, higher ceiling", () => {
    const input = baseInput();
    const tooLong = "x".repeat(LONG_FIELD_MAX_LENGTH + 1);
    input.extraction = {
      ...input.extraction,
      government_warning: { ...input.extraction.government_warning, transcription: tooLong, evidence: tooLong },
    };
    expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/government_warning\.transcription/);
  });

  it("collects every problem in one pass, not just the first", () => {
    const input = baseInput();
    input.application = makeResolverApplication({
      brandName: "A".repeat(SHORT_FIELD_MAX_LENGTH + 1),
      classType: "B".repeat(SHORT_FIELD_MAX_LENGTH + 1),
    });
    let error: unknown;
    try {
      assertUntrustedInputWithinBounds(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ResolverInputError);
    const problems = (error as ResolverInputError).problems;
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join("\n")).toMatch(/brandName/);
    expect(problems.join("\n")).toMatch(/classType/);
  });

  it("does not flag a null value as too long", () => {
    const input = baseInput();
    input.extraction = {
      ...input.extraction,
      net_contents: { value: null, evidence: "", confidence: 0, alternates: [] },
    };
    expect(() => assertUntrustedInputWithinBounds(input)).not.toThrow();
  });
});
