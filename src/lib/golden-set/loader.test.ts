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
    provenance: "rendered",
    verified: false,
    vectors: ["V1"],
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

  it("rejects an unknown provenance value", () => {
    const broken = manifest([
      // @ts-expect-error -- intentionally malformed input for the red-first test
      validCase({ provenance: "hand-drawn" }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
  });

  it("rejects an unknown rubric vector", () => {
    const broken = manifest([
      // @ts-expect-error -- intentionally malformed input for the red-first test
      validCase({ vectors: ["V1", "V99"] }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("V99"))).toBe(true);
    }
  });

  it("rejects an ai-generated case that is not verified", () => {
    const broken = manifest([
      validCase({ provenance: "ai-generated", verified: false }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("ai-generated") && p.includes("verified"))).toBe(true);
    }
  });

  it("accepts an ai-generated case that is verified", () => {
    const ok = manifest([
      validCase({ provenance: "ai-generated", verified: true }),
    ]);

    expect(() => validateManifest(ok)).not.toThrow();
  });

  it("accepts a case with a well-formed degradations list", () => {
    const ok = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [
          { type: "rotate", params: { angleDegrees: 15 } },
          { type: "glare", params: { region: "brand", opacity: 0.85 } },
        ],
      }),
    ]);

    expect(() => validateManifest(ok)).not.toThrow();
  });

  it("accepts every degradation type with its required params present", () => {
    const ok = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [
          { type: "rotate", params: { angleDegrees: 180 } },
          { type: "blur", params: { sigma: 18 } },
          { type: "perspective", params: { shear: 0.15 } },
          { type: "glare", params: { region: "warning" } },
          { type: "low-light", params: { region: "front", brightnessFactor: 0.3 } },
        ],
      }),
    ]);

    expect(() => validateManifest(ok)).not.toThrow();
  });

  it("accepts a case with no degradations field at all", () => {
    const ok = manifest([validCase()]);
    expect(() => validateManifest(ok)).not.toThrow();
  });

  it("rejects an unknown degradation type", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        // @ts-expect-error -- intentionally malformed input for the red-first test
        degradations: [{ type: "sepia", params: {} }],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("sepia"))).toBe(true);
    }
  });

  it("rejects a rotate degradation missing angleDegrees", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [{ type: "rotate", params: {} }],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("angleDegrees"))).toBe(true);
    }
  });

  it("rejects a glare degradation whose region is the wrong type", () => {
    // No @ts-expect-error here: `params` is typed `Record<string, number |
    // string>`, so `region: 42` type-checks fine — this is a schema-level
    // mistake (glare's `region` must actually be a string), not a type
    // error, which is exactly what checkDegradations is for.
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [{ type: "glare", params: { region: 42 } }],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("region"))).toBe(true);
    }
  });

  it("accepts glare's optional angleDegrees and opacity when present and well-typed", () => {
    const ok = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [
          { type: "glare", params: { region: "brand", angleDegrees: 25, opacity: 0.85 } },
        ],
      }),
    ]);
    expect(() => validateManifest(ok)).not.toThrow();
  });

  it("rejects glare's optional opacity when present but wrong-typed", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [{ type: "glare", params: { region: "brand", opacity: "0.85" } }],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("opacity"))).toBe(true);
    }
  });

  it("rejects a degradation param the transform does not accept (closed schema)", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [
          { type: "rotate", params: { angleDegrees: 15, sigma: 20 } },
        ],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("sigma") && p.includes("does not accept"))).toBe(
        true,
      );
    }
  });

  it("rejects a non-empty degradations list on a case that isn't rendered+degraded", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered",
        degradations: [{ type: "rotate", params: { angleDegrees: 15 } }],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("degradations") && p.includes("rendered"))).toBe(true);
    }
  });

  it("accepts an empty degradations list regardless of provenance", () => {
    const ok = manifest([validCase({ provenance: "rendered", degradations: [] })]);
    expect(() => validateManifest(ok)).not.toThrow();
  });

  it("rejects a degradation missing params", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        // @ts-expect-error -- intentionally malformed input for the red-first test
        degradations: [{ type: "rotate" }],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("params"))).toBe(true);
    }
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

  it("covers 8 of 10 rubric vectors; V7 and V10 are known gaps (design doc §4)", () => {
    // V7 (net-contents format match, e.g. "750 mL" vs "750ml") has no
    // dedicated case yet. V10 (batch of >=20) is a property of the manifest
    // as a whole, not any single case, and is asserted separately below.
    // If this test starts failing because V7 got covered, DELETE the
    // exclusion, don't widen it — that is the gap closing, which is good.
    const result = loadGoldenSetManifest();
    const covered = new Set(result.cases.flatMap((c) => c.vectors));
    const allVectors = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10"] as const;
    const knownGaps = new Set(["V7", "V10"]);
    for (const v of allVectors) {
      if (knownGaps.has(v)) {
        expect(covered.has(v), `${v} was expected to still be a known gap`).toBe(false);
      } else {
        expect(covered.has(v), `${v} should be covered by at least one case`).toBe(true);
      }
    }
  });

  it("has at least 20 cases usable as a batch (V10's requirement on the set, not one case)", () => {
    const result = loadGoldenSetManifest();
    expect(result.cases.length).toBeGreaterThanOrEqual(20);
  });

  it("requires every ai-generated case to be verified before it can load", () => {
    const result = loadGoldenSetManifest();
    const aiGenerated = result.cases.filter((c) => c.provenance === "ai-generated");
    for (const c of aiGenerated) {
      expect(c.verified, `${c.caseId} is ai-generated and must be verified`).toBe(true);
    }
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
