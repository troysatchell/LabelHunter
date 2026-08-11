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
  return {
    application: input.application,
    extraction: input.extraction,
    router: input.router,
    flaggedFields: input.flaggedFields,
  };
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

  describe("every serialized ApplicationRecord field is checked, not just brandName/classType", () => {
    it("rejects an implausibly long beverageType", () => {
      const input = baseInput();
      // beverageType is typed as a closed enum, but this validator treats it
      // as untrusted data anyway — the cast simulates a value that reached
      // here without going through toBeverageType (../../lib/db/enums.ts).
      input.application = makeResolverApplication({ beverageType: "A".repeat(SHORT_FIELD_MAX_LENGTH + 1) as never });
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/application\.beverageType/);
    });

    it("rejects an implausibly long netContentsUnit", () => {
      const input = baseInput();
      input.application = makeResolverApplication({ netContentsUnit: "m".repeat(SHORT_FIELD_MAX_LENGTH + 1) });
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/application\.netContentsUnit/);
    });

    it("rejects a non-finite alcoholContentPercent (NaN)", () => {
      const input = baseInput();
      input.application = makeResolverApplication({ alcoholContentPercent: Number.NaN });
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/application\.alcoholContentPercent.*finite number/);
    });

    it("rejects a non-finite alcoholContentPercent (Infinity) — JSON.stringify silently turns this into null otherwise", () => {
      const input = baseInput();
      input.application = makeResolverApplication({ alcoholContentPercent: Number.POSITIVE_INFINITY });
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/application\.alcoholContentPercent/);
    });

    it("accepts an absent alcoholContentPercent — it is a legitimately optional field", () => {
      const input = baseInput();
      input.application = { ...makeResolverApplication(), alcoholContentPercent: undefined };
      expect(() => assertUntrustedInputWithinBounds(input)).not.toThrow();
    });

    it("rejects a non-finite netContentsValue — this field is required, never legitimately absent", () => {
      const input = baseInput();
      input.application = makeResolverApplication({ netContentsValue: Number.NaN });
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/application\.netContentsValue.*finite number/);
    });
  });

  describe("runtime type checks — the declared TypeScript type is not trusted at this boundary", () => {
    it("rejects a string field that is actually a number at runtime, not just wrong-length", () => {
      const input = baseInput();
      input.extraction = {
        ...input.extraction,
        brand_name: { value: 12345 as unknown as string, evidence: "x", confidence: 0.9, alternates: [] },
      };
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.brand_name\.value.*expected a string or null/);
    });

    it("rejects a string field that is actually an object at runtime, without throwing an uncontrolled TypeError", () => {
      const input = baseInput();
      input.extraction = {
        ...input.extraction,
        class_type: { value: { nested: "object" } as unknown as string, evidence: "x", confidence: 0.9, alternates: [] },
      };
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.class_type\.value.*expected a string or null/);
    });

    it("rejects an alternates array that is actually a string at runtime", () => {
      const input = baseInput();
      input.extraction = {
        ...input.extraction,
        net_contents: { value: "750 mL", evidence: "750 mL", confidence: 0.9, alternates: "not-an-array" as unknown as string[] },
      };
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.net_contents\.alternates.*expected an array/);
    });

    it("rejects an alternates entry that is not a string, without throwing an uncontrolled TypeError", () => {
      const input = baseInput();
      input.extraction = {
        ...input.extraction,
        alcohol_content: { value: "45%", evidence: "45%", confidence: 0.9, alternates: [42 as unknown as string] },
      };
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.alcohol_content\.alternates\[0\].*expected a string or null/);
    });

    it("rejects a null field container instead of crashing on extracted.value", () => {
      const input = baseInput();
      input.extraction = { ...input.extraction, class_type: null as never };
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.class_type.*expected an object/);
    });

    it("rejects an undefined field container instead of crashing on extracted.value", () => {
      const input = baseInput();
      const { brand_name: _dropped, ...withoutBrandName } = input.extraction;
      input.extraction = withoutBrandName as never;
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.brand_name.*expected an object/);
    });

    it("rejects a null government_warning container instead of crashing on its properties", () => {
      const input = baseInput();
      input.extraction = { ...input.extraction, government_warning: null as never };
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.government_warning.*expected an object/);
    });

    it("rejects an array where a field container is expected — arrays are objects too, but not the right shape", () => {
      const input = baseInput();
      input.extraction = { ...input.extraction, net_contents: [] as never };
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/extraction\.net_contents.*expected an object/);
    });
  });

  describe("router-derived text is validated too — PR #10 review", () => {
    it("rejects an implausibly long router field reason", () => {
      const input = baseInput();
      input.router = {
        ...input.router,
        fields: input.router.fields.map((row, i) => (i === 0 ? { ...row, reason: "x".repeat(SHORT_FIELD_MAX_LENGTH + 1) } : row)),
      };
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/router\.fields\[0\]\.reason/);
    });

    it("rejects an implausibly long flagged-field trigger", () => {
      const input = baseInput();
      input.flaggedFields = input.flaggedFields.map((flagged, i) =>
        i === 0 ? { ...flagged, trigger: "x".repeat(SHORT_FIELD_MAX_LENGTH + 1) } : flagged,
      );
      expect(() => assertUntrustedInputWithinBounds(input)).toThrow(/flaggedFields\[0\]\.trigger/);
    });

    it("accepts ordinary-length router reasons and triggers", () => {
      expect(() => assertUntrustedInputWithinBounds(baseInput())).not.toThrow();
    });
  });
});
