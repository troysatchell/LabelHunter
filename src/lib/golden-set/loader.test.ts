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
          { type: "glare", params: { region: "brand", opacity: 0.85 } },
          { type: "rotate", params: { angleDegrees: 15 } },
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
          { type: "glare", params: { region: "warning" } },
          { type: "low-light", params: { region: "front", brightnessFactor: 0.3 } },
          { type: "blur", params: { sigma: 18 } },
          { type: "rotate", params: { angleDegrees: 180 } },
          { type: "perspective", params: { shear: 0.15 } },
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

  it("rejects a glare entry that follows a 180-degree rotate entry", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [
          { type: "rotate", params: { angleDegrees: 180 } },
          { type: "glare", params: { region: "brand" } },
        ],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("glare") && p.includes("rotate"))).toBe(true);
    }
  });

  it("rejects a low-light entry that follows a 180-degree rotate entry", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [
          { type: "rotate", params: { angleDegrees: 180 } },
          { type: "low-light", params: { region: "warning", brightnessFactor: 0.3 } },
        ],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("low-light") && p.includes("rotate"))).toBe(true);
    }
  });

  it("rejects a glare entry that follows a perspective entry", () => {
    const broken = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [
          { type: "perspective", params: { shear: 0.15 } },
          { type: "glare", params: { region: "brand" } },
        ],
      }),
    ]);

    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      const problems = (err as GoldenSetValidationError).problems;
      expect(problems.some((p) => p.includes("glare") && p.includes("perspective"))).toBe(true);
    }
  });

  it("accepts a glare entry that comes before a rotate entry", () => {
    const ok = manifest([
      validCase({
        provenance: "rendered+degraded",
        degradations: [
          { type: "glare", params: { region: "brand" } },
          { type: "rotate", params: { angleDegrees: 180 } },
        ],
      }),
    ]);

    expect(() => validateManifest(ok)).not.toThrow();
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

  describe("validateManifest — rendered+ai-backdrop provenance", () => {
    const aiBackdropCase = (overrides: Partial<GoldenSetCase> = {}): GoldenSetCase =>
      validCase({
        caseId: "case-ai-backdrop-amber-whiskey-01-bar-counter-steady",
        imagePath: "golden-set/images/case-ai-backdrop-amber-whiskey-01-bar-counter-steady.jpg",
        provenance: "rendered+ai-backdrop",
        verified: true,
        referenceBottle: "amber-whiskey-01",
        scene: "bar-counter",
        cameraCondition: "steady",
        labelPlacement: {
          topLeft: { x: 120, y: 90 },
          topRight: { x: 420, y: 100 },
          bottomLeft: { x: 130, y: 380 },
          bottomRight: { x: 430, y: 390 },
        },
        generationMetadata: {
          model: "gemini-3.1-flash-image",
          resolution: "1K",
          promptVersion: "v1",
          generatedAt: "2026-08-11T00:00:00.000Z",
        },
        ...overrides,
      });

    it("accepts a well-formed rendered+ai-backdrop case", () => {
      const result = validateManifest(manifest([aiBackdropCase()]));
      expect(result.cases).toHaveLength(1);
    });

    it("rejects rendered+ai-backdrop with verified: false", () => {
      expect(() => validateManifest(manifest([aiBackdropCase({ verified: false })]))).toThrow(
        GoldenSetValidationError,
      );
    });

    it("rejects rendered+ai-backdrop missing referenceBottle", () => {
      const broken = manifest([aiBackdropCase()]);
      // referenceBottle is an optional field on GoldenSetCase (valid on any
      // provenance at the type level — the "only on rendered+ai-backdrop"
      // rule is manifest-level, not a type constraint), so deleting it here
      // is not a type error and needs no @ts-expect-error.
      delete broken.cases[0].referenceBottle;
      try {
        validateManifest(broken);
        expect.unreachable("validateManifest should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GoldenSetValidationError);
        expect((err as GoldenSetValidationError).problems.some((p) => p.includes("referenceBottle"))).toBe(
          true,
        );
      }
    });

    it("rejects rendered+ai-backdrop missing labelPlacement entirely", () => {
      const broken = manifest([aiBackdropCase()]);
      // Distinct from "rejects labelPlacement with a non-numeric corner"
      // below: this deletes the key entirely rather than malforming its
      // value, exercising checkCase's `if ("labelPlacement" in raw)` branch
      // instead of checkLabelPlacement.
      delete broken.cases[0].labelPlacement;
      try {
        validateManifest(broken);
        expect.unreachable("validateManifest should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GoldenSetValidationError);
        expect(
          (err as GoldenSetValidationError).problems.some((p) => p.includes("labelPlacement")),
        ).toBe(true);
      }
    });

    it("rejects rendered+ai-backdrop missing generationMetadata entirely", () => {
      const broken = manifest([aiBackdropCase()]);
      // Distinct from "rejects generationMetadata missing promptVersion"
      // below: this deletes the whole object, exercising checkCase's
      // `if ("generationMetadata" in raw)` branch instead of
      // checkGenerationMetadata's own field checks.
      delete broken.cases[0].generationMetadata;
      try {
        validateManifest(broken);
        expect.unreachable("validateManifest should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GoldenSetValidationError);
        expect(
          (err as GoldenSetValidationError).problems.some((p) => p.includes("generationMetadata")),
        ).toBe(true);
      }
    });

    it("rejects an invalid cameraCondition value", () => {
      expect(() =>
        validateManifest(
          // @ts-expect-error -- intentionally invalid enum value for the red-first test
          manifest([aiBackdropCase({ cameraCondition: "underwater" })]),
        ),
      ).toThrow(GoldenSetValidationError);
    });

    it("rejects labelPlacement with a non-numeric corner", () => {
      expect(() =>
        validateManifest(
          manifest([
            aiBackdropCase({
              // @ts-expect-error -- intentionally malformed input for the red-first test
              labelPlacement: { topLeft: { x: "left", y: 0 }, topRight: { x: 1, y: 0 }, bottomLeft: { x: 0, y: 1 }, bottomRight: { x: 1, y: 1 } },
            }),
          ]),
        ),
      ).toThrow(GoldenSetValidationError);
    });

    it("rejects generationMetadata missing promptVersion", () => {
      const broken = manifest([aiBackdropCase()]);
      // @ts-expect-error -- intentionally malformed input for the red-first test
      delete broken.cases[0].generationMetadata.promptVersion;
      expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    });

    it("rejects a generationMetadata.generatedAt that is not a parseable ISO-8601 timestamp", () => {
      const broken = manifest([
        aiBackdropCase({
          generationMetadata: {
            model: "gemini-3.1-flash-image",
            resolution: "1K",
            promptVersion: "v1",
            generatedAt: "unknown",
          },
        }),
      ]);
      try {
        validateManifest(broken);
        expect.unreachable("validateManifest should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GoldenSetValidationError);
        expect(
          (err as GoldenSetValidationError).problems.some((p) => p.includes("generatedAt")),
        ).toBe(true);
      }
    });

    it("rejects a generationMetadata.generatedAt that parses but is not the canonical toISOString format", () => {
      // Missing milliseconds -- new Date(...) parses this fine, but
      // toISOString() would always add ".000Z", so it round-trips to a
      // DIFFERENT string. isNonEmptyString alone would have accepted this.
      const broken = manifest([
        aiBackdropCase({
          generationMetadata: {
            model: "gemini-3.1-flash-image",
            resolution: "1K",
            promptVersion: "v1",
            generatedAt: "2026-08-11T00:00:00Z",
          },
        }),
      ]);
      expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
    });

    it("rejects referenceBottle set on a rendered (non-ai-backdrop) case", () => {
      // referenceBottle is type-valid on any GoldenSetCase regardless of
      // provenance (same reasoning as above) — this is a manifest-level
      // rule, so no @ts-expect-error is expected here either.
      expect(() =>
        validateManifest(manifest([validCase({ referenceBottle: "amber-whiskey-01" })])),
      ).toThrow(GoldenSetValidationError);
    });
  });
});

describe("loadGoldenSetManifest", () => {
  it("loads and validates the committed golden-set manifest", () => {
    const result = loadGoldenSetManifest();

    // PRD §6's own ballpark ("~20-30 generated labels"), plus two deliberate,
    // cited additions: TRO-515's net-contents format-variant case (case-30,
    // closing rubric vector V7) and TRO-469 / LH-021's two warning-relevant
    // cases CP-2 §9.2 findings 4/5 (docs/checkpoints/cp2-warning-subsystem.md)
    // identified as missing — the near-miss band (case-32) and the
    // Surgeon/General capitalization positions (case-31), numbered after
    // case-30 since TRO-515 landed on main first. 32, not 30 — growth, not
    // drift.
    expect(result.cases.length).toBeGreaterThanOrEqual(20);
    expect(result.cases.length).toBeLessThanOrEqual(32);

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

  it("includes the net-contents format-variant case required by rubric vector V7 (TRO-515)", () => {
    const result = loadGoldenSetManifest();
    const baseline = result.cases.find((c) => c.caseId === "case-01-clean-match-spirits");
    const altFormat = result.cases.find(
      (c) => c.caseId === "case-30-clean-match-net-contents-alt-format",
    );

    expect(baseline).toBeDefined();
    expect(altFormat).toBeDefined();

    // case-30 isolates the net-contents format difference as its ONE
    // distinguishing feature from case-01-clean-match-spirits (golden-set/
    // README.md's own claim about this case). Check that claim directly,
    // field by field, instead of trusting the prose: every field besides
    // net contents (and net contents' own VALUE, which the two cases still
    // share) must match case-01 exactly.
    expect(altFormat?.application.brandName).toBe(baseline?.application.brandName);
    expect(altFormat?.application.classType).toBe(baseline?.application.classType);
    expect(altFormat?.application.abvPercent).toBe(baseline?.application.abvPercent);
    expect(altFormat?.label.brandName).toBe(baseline?.label.brandName);
    expect(altFormat?.label.classType).toBe(baseline?.label.classType);
    expect(altFormat?.label.abvPresent).toBe(baseline?.label.abvPresent);
    expect(altFormat?.label.abvText).toBe(baseline?.label.abvText);
    expect(altFormat?.label.abvPercent).toBe(baseline?.label.abvPercent);
    expect(altFormat?.label.proof).toBe(baseline?.label.proof);
    expect(altFormat?.label.netContentsValue).toBe(baseline?.label.netContentsValue);
    expect(altFormat?.label.governmentWarningPresent).toBe(baseline?.label.governmentWarningPresent);
    expect(altFormat?.label.governmentWarningText).toBe(baseline?.label.governmentWarningText);
    expect(altFormat?.label.governmentWarningPrefixAllCaps).toBe(
      baseline?.label.governmentWarningPrefixAllCaps,
    );

    // audit/rubric.md Appendix A, V7: net contents "750 mL" vs "750ml" ->
    // MATCH. The label carries the odd format; the application carries the
    // canonical one — only `label` has a free-text netContentsText field.
    // This is the ONE thing that should differ from case-01 above.
    expect(altFormat?.label.netContentsText).toBe("750ml");
    expect(altFormat?.label.netContentsText).not.toBe(baseline?.label.netContentsText);
    expect(altFormat?.application.netContentsValue).toBe(750);
    expect(altFormat?.application.netContentsUnit).toBe("mL");
    expect(altFormat?.label.netContentsText).not.toBe(
      `${altFormat?.application.netContentsValue} ${altFormat?.application.netContentsUnit}`,
    );
    expect(altFormat?.expected.fields.netContents.verdict).toBe("MATCH");
    expect(altFormat?.vectors).toContain("V7");
  });

  it("covers all nine per-case rubric vectors; V10 stays a manifest-wide property, not a per-case gap (design doc §4)", () => {
    // V10 (batch of >=20) is a property of the manifest as a whole, not any
    // single case. The "at least 20 cases" test below asserts V10 directly.
    // No case may EVER individually tag it, so it is excluded from this
    // per-case loop on purpose — that exclusion is not a gap.
    //
    // TRO-515 closed the one real per-case gap, V7 (net-contents format
    // match, e.g. "750 mL" vs "750ml"): case-30-clean-match-net-contents-
    // alt-format now carries it. If this test starts failing because one of
    // the other eight vectors lost its only covering case, add a real
    // replacement case first — don't widen the exclusion below to paper
    // over a real regression.
    const result = loadGoldenSetManifest();
    const covered = new Set(result.cases.flatMap((c) => c.vectors));
    const allVectors = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10"] as const;
    const manifestWideOnly = new Set(["V10"]);
    for (const v of allVectors) {
      if (manifestWideOnly.has(v)) {
        expect(covered.has(v), `${v} is a manifest-wide property; no case should tag it individually`).toBe(false);
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
