/**
 * TH-R11 sanity check (LH-011 / TRO-461).
 *
 * TH-R11 requires the app to handle a label carrying Brand Name, Class/Type,
 * Alcohol Content, Net Contents, and Government Warning — the OLD TOM
 * DISTILLERY example. `golden-set/manifest.json` case
 * `case-01-clean-match-spirits` is the committed reference case for it
 * (TRO-458 / LH-003).
 *
 * `golden-set/images/` is still empty (LH-004/005/006 land the renderer), so
 * this is not an end-to-end call against a real photo — that is out of
 * scope for this ticket. What this test does check: a Haiku response shaped
 * like a correct read of that case's `label` ground truth parses into the
 * extractor's typed result, across all five TH-R11 fields plus
 * `beverage_type`, with no drift between the two.
 */
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../lib/golden-set/loader";
import { parseExtractionResponse } from "./response";
import { makeMockMessage } from "./test-support";

describe("TH-R11 reference example — case-01-clean-match-spirits", () => {
  const manifest = loadGoldenSetManifest();
  const referenceCase = manifest.cases.find(
    (c) => c.caseId === "case-01-clean-match-spirits",
  );

  it("is present in the golden set and named as the TH-R11 reference example", () => {
    expect(referenceCase).toBeDefined();
    expect(referenceCase?.notes).toMatch(/TH-R11 reference example/);
  });

  it("extracts across all five TH-R11 fields plus beverage_type", () => {
    if (!referenceCase) throw new Error("case-01-clean-match-spirits missing from manifest");
    const { label, beverageType } = referenceCase;

    // Precondition on the fixture itself. case-01 is the TH-R11 reference
    // case specifically because its warning is present and all-caps — if
    // that ground truth ever drifts, fail here with a clear reason instead
    // of a confusing mismatch further down that would look like a
    // parseExtractionResponse bug rather than a fixture change.
    expect(label.governmentWarningPresent).toBe(true);
    expect(label.governmentWarningPrefixAllCaps).toBe(true);

    // A Haiku response shaped like a correct, confident read of this case's
    // label ground truth — the shape the extractor must be able to parse
    // and hand back typed, evidence included for every field (PRD §3.2).
    const body = {
      image_quality: { legible: "yes", issues: ["none"], confidence: 0.97 },
      brand_name: {
        value: label.brandName,
        evidence: label.brandName.toUpperCase(),
        confidence: 0.95,
        alternates: [],
      },
      class_type: {
        value: label.classType,
        evidence: label.classType,
        confidence: 0.94,
        alternates: [],
      },
      alcohol_content: {
        value: label.abvText,
        evidence: label.abvText,
        confidence: 0.93,
        alternates: [],
      },
      net_contents: {
        value: label.netContentsText,
        evidence: label.netContentsText,
        confidence: 0.96,
        alternates: [],
      },
      beverage_type: {
        value: beverageType,
        evidence: label.classType,
        confidence: 0.9,
        alternates: [],
      },
      government_warning: {
        present: label.governmentWarningPresent,
        transcription: label.governmentWarningText,
        prefix_casing: label.governmentWarningPrefixAllCaps ? "ALL_CAPS" : "OTHER",
        formatting: { bold: "uncertain" },
        evidence: label.governmentWarningText,
        confidence: 0.98,
      },
    };

    const result = parseExtractionResponse(makeMockMessage(JSON.stringify(body)));

    // Brand Name (TH-R11)
    expect(result.brand_name.value).toBe(label.brandName);
    expect(result.brand_name.evidence.length).toBeGreaterThan(0);
    // Class/Type (TH-R11)
    expect(result.class_type.value).toBe(label.classType);
    // Alcohol Content (TH-R11)
    expect(result.alcohol_content.value).toBe(label.abvText);
    // Net Contents (TH-R11)
    expect(result.net_contents.value).toBe(label.netContentsText);
    // Government Warning (TH-R11) — compared against the manifest-derived
    // values (not a hardcoded "true"/"ALL_CAPS") so a change to the fixture
    // is caught by the precondition assertions above, not masked here by an
    // expectation that happens to still match by coincidence.
    expect(result.government_warning.present).toBe(label.governmentWarningPresent);
    expect(result.government_warning.transcription).toBe(label.governmentWarningText);
    expect(result.government_warning.prefix_casing).toBe(
      label.governmentWarningPrefixAllCaps ? "ALL_CAPS" : "OTHER",
    );
    // beverage_type — the free cross-check CP-1 §3.1 describes, not a
    // TH-R11 field itself, but part of the same schema.
    expect(result.beverage_type.value).toBe(beverageType);

    // Every field must carry evidence — a bare value with no supporting
    // text is not a valid extraction (PRD §3.2).
    for (const field of [
      result.brand_name,
      result.class_type,
      result.alcohol_content,
      result.net_contents,
    ]) {
      expect(field.evidence.length).toBeGreaterThan(0);
    }
  });
});
