import { describe, expect, it } from "vitest";
import {
  GoldenSetValidationError,
  loadGoldenSetManifest,
  validateManifest,
} from "./loader";
import type { GoldenSetCase, GoldenSetManifest } from "./types";

/** A single well-formed case, reused as a base for the malformed-manifest tests. */
function validCase(overrides: Partial<GoldenSetCase> = {}): GoldenSetCase {
  return {
    caseId: "case-01-clean-match",
    description: "Baseline label; every field matches the application.",
    category: "clean-match",
    beverageType: "spirits",
    imagePath: "golden-set/images/case-01-clean-match.jpg",
    application: {
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      abvPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    },
    label: {
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      abvPresent: true,
      abvText: "45% Alc./Vol. (90 Proof)",
      abvPercent: 45,
      proof: 90,
      netContentsText: "750 mL",
      netContentsValue: 750,
      netContentsUnit: "mL",
      governmentWarningPresent: true,
      governmentWarningText: "GOVERNMENT WARNING: (1) ...",
      governmentWarningPrefixAllCaps: true,
    },
    expected: {
      labelVerdict: "PASS",
      fields: {
        brandName: { verdict: "MATCH", reason: "Brand matches." },
        classType: { verdict: "MATCH", reason: "Class/type matches." },
        abv: { verdict: "MATCH", reason: "ABV matches." },
        netContents: { verdict: "MATCH", reason: "Net contents match." },
        governmentWarning: { verdict: "MATCH", reason: "Warning matches." },
      },
    },
    ...overrides,
  };
}

function manifest(cases: GoldenSetCase[]): GoldenSetManifest {
  return { version: "1.0.0", cases };
}

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = validateManifest(manifest([validCase()]));
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].caseId).toBe("case-01-clean-match");
  });

  it("rejects a manifest missing a required field", () => {
    const broken = manifest([validCase()]);
    // @ts-expect-error -- intentionally malformed input for the red-first test
    delete broken.cases[0].description;

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GoldenSetValidationError);
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("description"))).toBe(true);
    }
  });

  it("rejects a manifest with a wrong-typed field", () => {
    const broken = manifest([
      validCase({
        application: {
          brandName: "Old Tom Distillery",
          classType: "Straight Bourbon Whiskey",
          // @ts-expect-error -- intentionally malformed input for the red-first test: should be a number, not a string
          abvPercent: "forty-five",
          netContentsValue: 750,
          netContentsUnit: "mL",
        },
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("abvPercent"))).toBe(true);
    }
  });

  it("rejects a manifest with a duplicate case ID", () => {
    const broken = manifest([
      validCase({ caseId: "case-01-clean-match" }),
      validCase({ caseId: "case-01-clean-match" }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("duplicate"))).toBe(true);
    }
  });

  it("rejects an unknown category", () => {
    const broken = manifest([
      // @ts-expect-error -- intentionally malformed input for the red-first test
      validCase({ category: "not-a-real-category" }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
  });

  it("rejects a reviewReason on a case that is not REVIEW", () => {
    const broken = manifest([
      validCase({
        expected: {
          labelVerdict: "PASS",
          reviewReason: "LOW_IMAGE_QUALITY",
          fields: validCase().expected.fields,
        },
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
  });

  it("rejects a REVIEW case with no reviewReason", () => {
    const broken = manifest([
      validCase({
        expected: {
          labelVerdict: "REVIEW",
          fields: validCase().expected.fields,
        },
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
  });

  it("rejects an imagePath whose basename does not match the caseId", () => {
    const broken = manifest([
      validCase({ imagePath: "golden-set/images/some-other-name.jpg" }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
  });

  it("collects more than one problem in a single pass", () => {
    const broken = manifest([
      validCase({ caseId: "case-01-clean-match" }),
      validCase({ caseId: "case-01-clean-match" }),
    ]);
    // @ts-expect-error -- intentionally malformed input for the red-first test
    delete broken.cases[0].beverageType;

    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.length).toBeGreaterThan(1);
    }
  });
});

describe("loadGoldenSetManifest", () => {
  it("loads and validates the committed golden-set manifest", () => {
    const result = loadGoldenSetManifest();

    expect(result.cases.length).toBeGreaterThanOrEqual(20);
    expect(result.cases.length).toBeLessThanOrEqual(30);

    const ids = result.cases.map((c) => c.caseId);
    expect(new Set(ids).size).toBe(ids.length);

    const requiredCategories: GoldenSetCase["category"][] = [
      "clean-match",
      "abv-mismatch",
      "title-case-warning",
      "reworded-warning",
      "missing-warning",
      "case-variant-brand",
      "glare",
      "rotation",
      "low-light",
      "tiny-warning-text",
      "odd-typography",
      "conflicting-application-vs-label",
    ];
    const seenCategories = new Set(result.cases.map((c) => c.category));
    for (const category of requiredCategories) {
      expect(seenCategories.has(category)).toBe(true);
    }
  });

  it("includes the STONE'S THROW case-variant-brand case required by TH-R8", () => {
    const result = loadGoldenSetManifest();
    const stonesThrow = result.cases.find(
      (c) => c.caseId === "case-14-case-variant-brand-stones-throw",
    );

    expect(stonesThrow).toBeDefined();
    expect(stonesThrow?.label.brandName).toBe("STONE'S THROW");
    expect(stonesThrow?.application.brandName).toBe("Stone's Throw");
    expect(stonesThrow?.expected.fields.brandName.verdict).toBe("MATCH");
  });

  it("includes a title-case-warning case matching Jenny Park's catch required by TH-R9", () => {
    const result = loadGoldenSetManifest();
    const titleCase = result.cases.find(
      (c) => c.category === "title-case-warning",
    );

    expect(titleCase).toBeDefined();
    expect(titleCase?.label.governmentWarningPrefixAllCaps).toBe(false);
    expect(titleCase?.expected.fields.governmentWarning.verdict).toBe(
      "MISMATCH",
    );
    expect(titleCase?.expected.labelVerdict).toBe("FAIL");
  });
});
