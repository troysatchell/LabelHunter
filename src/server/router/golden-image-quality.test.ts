/**
 * TH-R10 (LH-051 / TRO-477): imperfect-image handling.
 *
 * TH-R10 sets one bar for a glare, rotation, or low-light label: the router
 * must return a correct extraction, or it must return an explicit
 * `LOW_IMAGE_QUALITY` review. It must never return a confident wrong
 * verdict. This file checks that bar against the six golden-set cases
 * tagged `glare`, `rotation`, or `low-light` (`golden-set/manifest.json`
 * case-17 through case-22).
 *
 * Each test builds a `HaikuExtractionResult` shaped like an honest read of
 * that case's photo defect — the same pattern `../extractor/golden-case
 * .test.ts` uses for case-01. This is NOT a live model call. No real image
 * ever reaches Haiku here; the fixture below is this file's own claim about
 * what an honest extractor, following its own prompt
 * (`../extractor/prompt.ts` rule 6: "Report low confidence when the image
 * blocks you. Glare, blur, an angle, low light, a crop, and an obstruction
 * all lower confidence"), would report. Ground-truth text (brand, class,
 * ABV, net contents, warning) comes from the manifest, not a hand-retyped
 * copy — a manifest edit cannot silently drift out of step with this file.
 *
 * `government_warning`'s own comparator result is a caller-supplied
 * contract this router does not compute (LH-020, gated by CP-2, not yet
 * built — see `./types.ts`'s `WarningComparatorResult` doc). Cases 17, 19,
 * and 21 (no warning-block defect) pass `CLEAN_WARNING_RESULT`, the same
 * "once LH-020 exists and reads a clean warning block, it returns MATCH"
 * stand-in `./index.test.ts`'s own suite already uses. Cases 18, 20, and 22
 * (a warning-block defect) instead pass `null` — TODAY's real production
 * value, since `route.ts` never calls LH-020 (it is not merged; see
 * `scripts/latency/measure.ts`'s own doc comment). Passing `null` there
 * proves this ticket's own mechanism — `isLowImageQuality`, driven by the
 * extractor's per-field confidence — carries the LOW_IMAGE_QUALITY headline
 * on its own. No warning-quality detector is built here (standing rule 11).
 */
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../lib/golden-set/loader";
import type { GoldenSetCase } from "../../lib/golden-set/types";
import { productionComparators } from "../comparators";
import type { HaikuExtractionResult } from "../extractor/types";
import { routeLabel } from "./index";
import { CLEAN_WARNING_RESULT, makePreprocessing } from "./test-support";
import type { ApplicationRecord, LabelRouterResult, RouterFieldKey } from "./types";

const manifest = loadGoldenSetManifest();

function goldenCase(caseId: string): GoldenSetCase {
  const found = manifest.cases.find((c) => c.caseId === caseId);
  if (!found) {
    throw new Error(`golden-image-quality.test.ts: no golden-set case "${caseId}"`);
  }
  return found;
}

function applicationFromGoldenCase(caseSpec: GoldenSetCase): ApplicationRecord {
  return {
    beverageType: caseSpec.beverageType,
    brandName: caseSpec.application.brandName,
    classType: caseSpec.application.classType,
    alcoholContentPercent: caseSpec.application.abvPercent,
    netContentsValue: caseSpec.application.netContentsValue,
    netContentsUnit: caseSpec.application.netContentsUnit,
  };
}

/** Maps the manifest's per-field expectation keys to the router's own
 * `RouterFieldKey`s, so a test asserts against the manifest directly instead
 * of a hand-copied paraphrase (standing rule 15). */
const GOLDEN_FIELD_TO_ROUTER_FIELD: [keyof GoldenSetCase["expected"]["fields"], RouterFieldKey][] = [
  ["brandName", "brand_name"],
  ["classType", "class_type"],
  ["abv", "alcohol_content"],
  ["netContents", "net_contents"],
  ["governmentWarning", "government_warning"],
];

/**
 * Asserts `result` against `caseSpec.expected`, field by field, plus TH-R10's
 * own bar stated directly: a case whose ground truth is REVIEW never comes
 * back as a confident PASS or FAIL. Also checks `resolvedBy` stays `null` on
 * every row — this router never calls Sonnet inline (TH-R19); a golden case
 * resolves in one deterministic pass or it does not resolve at all here.
 */
function expectMatchesGoldenCase(result: LabelRouterResult, caseSpec: GoldenSetCase): void {
  expect(result.labelVerdict).toBe(caseSpec.expected.labelVerdict);
  expect(result.headlineReason).toBe(caseSpec.expected.reviewReason ?? null);
  if (caseSpec.expected.labelVerdict === "REVIEW") {
    expect(result.labelVerdict).not.toBe("PASS");
    expect(result.labelVerdict).not.toBe("FAIL");
  }
  for (const [goldenKey, routerField] of GOLDEN_FIELD_TO_ROUTER_FIELD) {
    const row = result.fields.find((f) => f.field === routerField);
    expect(row, `${caseSpec.caseId}: missing a "${routerField}" row`).toBeDefined();
    expect(row?.verdict, `${caseSpec.caseId}: "${routerField}" verdict`).toBe(
      caseSpec.expected.fields[goldenKey].verdict,
    );
  }
  expect(result.fields.every((row) => row.resolvedBy === null)).toBe(true);
}

describe("TH-R10 golden cases are present and tagged as this ticket expects", () => {
  it.each([
    ["case-17-glare-front-label", "glare"],
    ["case-18-glare-warning-block", "glare"],
    ["case-19-rotation-mild-correctable", "rotation"],
    ["case-20-rotation-severe-upside-down", "rotation"],
    ["case-21-low-light-front-label", "low-light"],
    ["case-22-low-light-warning-block", "low-light"],
  ])("%s is category %s", (caseId, category) => {
    expect(goldenCase(caseId).category).toBe(category);
  });
});

describe("case-17-glare-front-label — glare over the brand name only", () => {
  it("routes to REVIEW/LOW_IMAGE_QUALITY; brand_name NEEDS_REVIEW, every other field MATCH", () => {
    const caseSpec = goldenCase("case-17-glare-front-label");
    const { label, beverageType } = caseSpec;

    const extraction: HaikuExtractionResult = {
      // Only the brand-name region has glare; the rest of the label reads
      // cleanly, so an honest whole-image read is "partial", not "no".
      image_quality: { legible: "partial", issues: ["glare"], confidence: 0.78 },
      brand_name: {
        value: label.brandName,
        evidence: label.brandName.toUpperCase(),
        // Below the Unusable floor (0.60): glare crosses the brand name, so
        // the model can still make out the letters but is not confident of
        // them (prompt.ts rule 6).
        confidence: 0.45,
        alternates: [],
      },
      class_type: { value: label.classType, evidence: label.classType, confidence: 0.93, alternates: [] },
      alcohol_content: { value: label.abvText, evidence: label.abvText, confidence: 0.91, alternates: [] },
      net_contents: { value: label.netContentsText, evidence: label.netContentsText, confidence: 0.95, alternates: [] },
      beverage_type: { value: beverageType, evidence: label.classType, confidence: 0.9, alternates: [] },
      government_warning: {
        present: label.governmentWarningPresent,
        transcription: label.governmentWarningText,
        prefix_casing: label.governmentWarningPrefixAllCaps ? "ALL_CAPS" : "OTHER",
        formatting: { bold: "uncertain" },
        evidence: label.governmentWarningText,
        confidence: 0.96,
      },
    };

    const result = routeLabel(
      extraction,
      applicationFromGoldenCase(caseSpec),
      productionComparators,
      CLEAN_WARNING_RESULT,
      makePreprocessing(),
    );

    expectMatchesGoldenCase(result, caseSpec);
  });
});

describe("case-18-glare-warning-block — glare over the warning block only", () => {
  it("routes to REVIEW/LOW_IMAGE_QUALITY; government_warning NEEDS_REVIEW, every other field MATCH", () => {
    const caseSpec = goldenCase("case-18-glare-warning-block");
    const { label, beverageType } = caseSpec;

    const extraction: HaikuExtractionResult = {
      image_quality: { legible: "partial", issues: ["glare"], confidence: 0.8 },
      brand_name: { value: label.brandName, evidence: label.brandName.toUpperCase(), confidence: 0.95, alternates: [] },
      class_type: { value: label.classType, evidence: label.classType, confidence: 0.94, alternates: [] },
      alcohol_content: { value: label.abvText, evidence: label.abvText, confidence: 0.93, alternates: [] },
      net_contents: { value: label.netContentsText, evidence: label.netContentsText, confidence: 0.95, alternates: [] },
      beverage_type: { value: beverageType, evidence: label.classType, confidence: 0.9, alternates: [] },
      government_warning: {
        present: label.governmentWarningPresent,
        transcription: label.governmentWarningText,
        prefix_casing: label.governmentWarningPrefixAllCaps ? "ALL_CAPS" : "OTHER",
        formatting: { bold: "uncertain" },
        evidence: label.governmentWarningText,
        // Glare crosses the warning block specifically — below the Unusable
        // floor even though the rest of the label reads cleanly.
        confidence: 0.4,
      },
    };

    // `warningResult: null` — today's real production value (LH-020, the
    // warning subsystem, is not merged; `route.ts` always passes `null`, per
    // `scripts/latency/measure.ts`'s own doc comment). This case still must
    // headline LOW_IMAGE_QUALITY with a null warning result — proving the
    // label-level blocker (`isLowImageQuality`, this ticket's own mechanism)
    // carries it, not a hypothetical future warning subsystem standing in.
    const result = routeLabel(
      extraction,
      applicationFromGoldenCase(caseSpec),
      productionComparators,
      null,
      makePreprocessing(),
    );

    expectMatchesGoldenCase(result, caseSpec);
  });
});

describe("case-19-rotation-mild-correctable — a 15-degree camera tilt", () => {
  it("still reads confidently: PASS, every field MATCH — the router does not overreact to a mere angle", () => {
    const caseSpec = goldenCase("case-19-rotation-mild-correctable");
    const { label, beverageType } = caseSpec;

    const extraction: HaikuExtractionResult = {
      // A 15-degree tilt is well within a vision model's tolerance. This
      // case exists to prove the router stays confident on a moderate
      // camera angle instead of reflexively escalating (manifest note).
      image_quality: { legible: "yes", issues: ["none"], confidence: 0.95 },
      brand_name: { value: label.brandName, evidence: label.brandName.toUpperCase(), confidence: 0.94, alternates: [] },
      class_type: { value: label.classType, evidence: label.classType, confidence: 0.93, alternates: [] },
      alcohol_content: { value: label.abvText, evidence: label.abvText, confidence: 0.92, alternates: [] },
      net_contents: { value: label.netContentsText, evidence: label.netContentsText, confidence: 0.95, alternates: [] },
      beverage_type: { value: beverageType, evidence: label.classType, confidence: 0.9, alternates: [] },
      government_warning: {
        present: label.governmentWarningPresent,
        transcription: label.governmentWarningText,
        prefix_casing: label.governmentWarningPrefixAllCaps ? "ALL_CAPS" : "OTHER",
        formatting: { bold: "uncertain" },
        evidence: label.governmentWarningText,
        confidence: 0.96,
      },
    };

    const result = routeLabel(
      extraction,
      applicationFromGoldenCase(caseSpec),
      productionComparators,
      CLEAN_WARNING_RESULT,
      makePreprocessing(),
    );

    expectMatchesGoldenCase(result, caseSpec);
  });
});

describe("case-20-rotation-severe-upside-down — upside down and out of focus", () => {
  it("routes to REVIEW/LOW_IMAGE_QUALITY; every field NEEDS_REVIEW — nothing reads reliably", () => {
    const caseSpec = goldenCase("case-20-rotation-severe-upside-down");

    const extraction: HaikuExtractionResult = {
      image_quality: { legible: "no", issues: ["rotation", "blur"], confidence: 0.08 },
      // Every field: the model tried and could not produce a usable read —
      // not "the label omits this field" (prompt.ts rule 4's confidence
      // 0.00 case), so confidence is low but not exactly zero.
      brand_name: { value: null, evidence: "", confidence: 0.05, alternates: [] },
      class_type: { value: null, evidence: "", confidence: 0.05, alternates: [] },
      alcohol_content: { value: null, evidence: "", confidence: 0.05, alternates: [] },
      net_contents: { value: null, evidence: "", confidence: 0.05, alternates: [] },
      beverage_type: { value: null, evidence: "", confidence: 0.05, alternates: [] },
      government_warning: {
        // Upside down and badly blurred: the model cannot even tell a
        // warning block is present, so it reports the schema's explicit
        // "not visible" state rather than guessing true or false.
        present: false,
        transcription: null,
        prefix_casing: "NOT_VISIBLE",
        formatting: { bold: "uncertain" },
        evidence: "",
        confidence: 0.05,
      },
    };

    const result = routeLabel(
      extraction,
      applicationFromGoldenCase(caseSpec),
      productionComparators,
      // null — today's real production value (see case-18's note above),
      // and moot here either way: government_warning resolves via the
      // "absent" path before this router ever consults a warning result.
      null,
      makePreprocessing(),
    );

    expectMatchesGoldenCase(result, caseSpec);
  });
});

describe("case-21-low-light-front-label — dim front label, evenly lit back label", () => {
  it("routes to REVIEW/LOW_IMAGE_QUALITY; brand_name and class_type NEEDS_REVIEW, back-label fields MATCH", () => {
    const caseSpec = goldenCase("case-21-low-light-front-label");
    const { label, beverageType } = caseSpec;

    const extraction: HaikuExtractionResult = {
      image_quality: { legible: "partial", issues: ["low_light"], confidence: 0.72 },
      brand_name: { value: label.brandName, evidence: label.brandName, confidence: 0.5, alternates: [] },
      class_type: { value: label.classType, evidence: label.classType, confidence: 0.5, alternates: [] },
      // Back label — evenly lit, reads cleanly.
      alcohol_content: { value: label.abvText, evidence: label.abvText, confidence: 0.92, alternates: [] },
      net_contents: { value: label.netContentsText, evidence: label.netContentsText, confidence: 0.94, alternates: [] },
      beverage_type: { value: beverageType, evidence: label.classType, confidence: 0.55, alternates: [] },
      government_warning: {
        present: label.governmentWarningPresent,
        transcription: label.governmentWarningText,
        prefix_casing: label.governmentWarningPrefixAllCaps ? "ALL_CAPS" : "OTHER",
        formatting: { bold: "uncertain" },
        evidence: label.governmentWarningText,
        confidence: 0.95,
      },
    };

    const result = routeLabel(
      extraction,
      applicationFromGoldenCase(caseSpec),
      productionComparators,
      CLEAN_WARNING_RESULT,
      makePreprocessing(),
    );

    expectMatchesGoldenCase(result, caseSpec);
  });
});

describe("case-22-low-light-warning-block — dim warning block, everything else evenly lit", () => {
  it("routes to REVIEW/LOW_IMAGE_QUALITY; government_warning NEEDS_REVIEW, every other field MATCH", () => {
    const caseSpec = goldenCase("case-22-low-light-warning-block");
    const { label, beverageType } = caseSpec;

    const extraction: HaikuExtractionResult = {
      image_quality: { legible: "partial", issues: ["low_light"], confidence: 0.74 },
      brand_name: { value: label.brandName, evidence: label.brandName, confidence: 0.94, alternates: [] },
      class_type: { value: label.classType, evidence: label.classType, confidence: 0.93, alternates: [] },
      alcohol_content: { value: label.abvText, evidence: label.abvText, confidence: 0.91, alternates: [] },
      net_contents: { value: label.netContentsText, evidence: label.netContentsText, confidence: 0.95, alternates: [] },
      beverage_type: { value: beverageType, evidence: label.classType, confidence: 0.9, alternates: [] },
      government_warning: {
        present: label.governmentWarningPresent,
        transcription: label.governmentWarningText,
        prefix_casing: label.governmentWarningPrefixAllCaps ? "ALL_CAPS" : "OTHER",
        formatting: { bold: "uncertain" },
        evidence: label.governmentWarningText,
        // Dim lighting over the warning block specifically — below the
        // Unusable floor even though the rest of the label reads cleanly.
        confidence: 0.42,
      },
    };

    // `warningResult: null` — see case-18's note above: this is today's real
    // production value, and this case must still headline LOW_IMAGE_QUALITY
    // through this ticket's own per-field-confidence mechanism alone.
    const result = routeLabel(
      extraction,
      applicationFromGoldenCase(caseSpec),
      productionComparators,
      null,
      makePreprocessing(),
    );

    expectMatchesGoldenCase(result, caseSpec);
  });
});
