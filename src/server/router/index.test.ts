import { describe, expect, it } from "vitest";
import { applyFieldOverrides } from "./overrides";
import {
  CLEAN_WARNING_RESULT,
  makeApplication,
  makeExtraction,
  makePreprocessing,
  placeholderComparators,
} from "./test-support";
import { routeLabel } from "./index";

describe("routeLabel — a clean label passes", () => {
  it("returns PASS with no headline reason when every field agrees", () => {
    const result = routeLabel(
      makeExtraction(),
      makeApplication(),
      placeholderComparators,
      CLEAN_WARNING_RESULT,
      makePreprocessing(),
    );
    expect(result.labelVerdict).toBe("PASS");
    expect(result.headlineReason).toBeNull();
    expect(result.fields).toHaveLength(5);
    expect(result.fields.every((row) => row.verdict === "MATCH")).toBe(true);
    expect(result.fields.every((row) => row.resolvedBy === null)).toBe(true);
  });
});

describe("routeLabel — TRO-502: beverage_type's exemption from override rule 2", () => {
  it("would be rejected by the text word-boundary check, without the exemption", () => {
    // Proves the exemption is load-bearing: without it, this ticket's own
    // clean fixture (beverage_type "spirits", evidence "Straight Bourbon
    // Whiskey") fails the general rule 2 check every other field uses.
    const extraction = makeExtraction();
    const outcome = applyFieldOverrides(extraction.beverage_type, "text");
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("evidence_does_not_support_value");
  });

  it("does not block a clean label end to end, with the exemption applied", () => {
    const result = routeLabel(
      makeExtraction(),
      makeApplication(),
      placeholderComparators,
      CLEAN_WARNING_RESULT,
      makePreprocessing(),
    );
    expect(result.labelVerdict).toBe("PASS");
    // Stronger than "not CONFLICTING_EXTRACTION": PASS already implies no
    // reason fired at all, label-level or field-level.
    expect(result.headlineReason).toBeNull();
  });
});

describe("routeLabel — AMBIGUOUS_ABV: CP-1 §5.3's named proof-arithmetic case", () => {
  it("'45% Alc./Vol. (100 Proof)' is self-contradictory and routes to REVIEW", () => {
    const extraction = makeExtraction({
      alcohol_content: {
        value: "45% Alc./Vol. (100 Proof)",
        evidence: "45% Alc./Vol. (100 Proof)",
        confidence: 0.9,
        alternates: [],
      },
    });
    const result = routeLabel(extraction, makeApplication(), placeholderComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    expect(result.labelVerdict).toBe("REVIEW");
    expect(result.headlineReason).toBe("AMBIGUOUS_ABV");
    const abvRow = result.fields.find((row) => row.field === "alcohol_content");
    expect(abvRow?.verdict).toBe("NEEDS_REVIEW");
    expect(abvRow?.reviewReason).toBe("AMBIGUOUS_ABV");
    // Never a bare confidence percentage in the UI reason (PRD §3.3, TH-R20).
    expect(abvRow?.reason).not.toMatch(/%/);
  });
});

describe("routeLabel — LOW_IMAGE_QUALITY suppresses the headline, even with clean fields", () => {
  it("routes to REVIEW with LOW_IMAGE_QUALITY as the headline", () => {
    const extraction = makeExtraction({ image_quality: { legible: "no", issues: ["blur"], confidence: 0.3 } });
    const result = routeLabel(extraction, makeApplication(), placeholderComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    expect(result.labelVerdict).toBe("REVIEW");
    expect(result.headlineReason).toBe("LOW_IMAGE_QUALITY");
  });
});

describe("routeLabel — CONFLICTING_EXTRACTION: a hallucinated value the evidence never supports", () => {
  it("rejects the field to null and routes the label to REVIEW", () => {
    const extraction = makeExtraction({
      brand_name: { value: "Fake Brand Inc", evidence: "OLD TOM DISTILLERY", confidence: 0.95, alternates: [] },
    });
    const result = routeLabel(extraction, makeApplication(), placeholderComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    expect(result.labelVerdict).toBe("REVIEW");
    expect(result.headlineReason).toBe("CONFLICTING_EXTRACTION");
    const brandRow = result.fields.find((row) => row.field === "brand_name");
    expect(brandRow?.verdict).toBe("NEEDS_REVIEW");
    expect(brandRow?.reviewReason).toBe("CONFLICTING_EXTRACTION");
    expect(brandRow?.labelValue).toBeNull();
  });
});

describe("routeLabel — MISSING_REQUIRED_FIELD: a legitimately absent required field", () => {
  it("routes the label to REVIEW with the field's own reason", () => {
    const extraction = makeExtraction({
      net_contents: { value: null, evidence: "", confidence: 0, alternates: [] },
    });
    const result = routeLabel(extraction, makeApplication(), placeholderComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    expect(result.labelVerdict).toBe("REVIEW");
    expect(result.headlineReason).toBe("MISSING_REQUIRED_FIELD");
    const netRow = result.fields.find((row) => row.field === "net_contents");
    expect(netRow?.reviewReason).toBe("MISSING_REQUIRED_FIELD");
  });
});

describe("routeLabel — WARNING_MISMATCH: the contract only, no warning logic built here", () => {
  it("routes on whatever the caller-supplied warning comparator result says", () => {
    const result = routeLabel(
      makeExtraction(),
      makeApplication(),
      placeholderComparators,
      { verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH", note: "VLM and OCR transcriptions disagree." },
      makePreprocessing(),
    );

    expect(result.labelVerdict).toBe("REVIEW");
    expect(result.headlineReason).toBe("WARNING_MISMATCH");
    const warningRow = result.fields.find((row) => row.field === "government_warning");
    expect(warningRow?.verdict).toBe("NEEDS_REVIEW");
    expect(warningRow?.reviewReason).toBe("WARNING_MISMATCH");
    expect(warningRow?.reason).toBe("VLM and OCR transcriptions disagree.");
  });
});

describe("routeLabel — beverage_type disagreement is checked after normalization", () => {
  it("a casing or whitespace difference alone is not a real disagreement", () => {
    // beverage_type.value is a free-form string in the extractor's JSON
    // schema, not an enum the schema itself constrains — a model could
    // return "Spirits" or " spirits " without violating the schema.
    const extraction = makeExtraction({
      beverage_type: { value: " Spirits ", evidence: "Straight Bourbon Whiskey", confidence: 0.95, alternates: [] },
    });
    const result = routeLabel(extraction, makeApplication({ beverageType: "spirits" }), placeholderComparators, CLEAN_WARNING_RESULT, makePreprocessing());
    expect(result.labelVerdict).toBe("PASS");
    expect(result.headlineReason).toBeNull();
  });

  it("a genuine disagreement at confident confidence still routes to CONFLICTING_EXTRACTION", () => {
    const extraction = makeExtraction({
      beverage_type: { value: "wine", evidence: "Straight Bourbon Whiskey", confidence: 0.95, alternates: [] },
    });
    const result = routeLabel(extraction, makeApplication({ beverageType: "spirits" }), placeholderComparators, CLEAN_WARNING_RESULT, makePreprocessing());
    expect(result.labelVerdict).toBe("REVIEW");
    expect(result.headlineReason).toBe("CONFLICTING_EXTRACTION");
  });
});

describe("routeLabel — the application does not state an alcohol percent to compare", () => {
  it("never falls back to a bare MATCH with nothing compared — it escalates instead (TH-R10)", () => {
    const result = routeLabel(
      makeExtraction(),
      makeApplication({ alcoholContentPercent: undefined }),
      placeholderComparators,
      CLEAN_WARNING_RESULT,
      makePreprocessing(),
    );
    const abvRow = result.fields.find((row) => row.field === "alcohol_content");
    // No comparator ran (nothing to compare against), so this is not a
    // confirmed match — asserting one would be a confident wrong verdict.
    expect(abvRow?.verdict).toBe("NEEDS_REVIEW");
    expect(abvRow?.reviewReason).toBe("AMBIGUOUS_ABV");
    expect(abvRow?.applicationValue).toBe("(not filed on the application)");
  });
});

describe("routeLabel — a required field absent under LOW_IMAGE_QUALITY (CP-1 §5.3's carve-out)", () => {
  it("does not word the row as a match, even with reviewReason suppressed to null", () => {
    const extraction = makeExtraction({
      image_quality: { legible: "no", issues: ["blur"], confidence: 0.2 },
      net_contents: { value: null, evidence: "", confidence: 0, alternates: [] },
    });
    const result = routeLabel(extraction, makeApplication(), placeholderComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    expect(result.labelVerdict).toBe("REVIEW");
    expect(result.headlineReason).toBe("LOW_IMAGE_QUALITY");
    const netRow = result.fields.find((row) => row.field === "net_contents");
    expect(netRow?.verdict).toBe("NEEDS_REVIEW");
    // MISSING_REQUIRED_FIELD is suppressed (CP-1 §5.3), so this field's own
    // reviewReason is null — but the reason text must still say the field
    // needs review, never "Matches the application."
    expect(netRow?.reviewReason).toBeNull();
    expect(netRow?.reason).toBe("A reviewer must check this field.");
  });
});

describe("routeLabel — a confident MISMATCH rolls up to FAIL", () => {
  it("does not escalate a high-confidence mismatch, and the label fails", () => {
    const comparators = {
      ...placeholderComparators,
      alcohol_content: () => ({ verdict: "MISMATCH" as const }),
    };
    const result = routeLabel(makeExtraction(), makeApplication(), comparators, CLEAN_WARNING_RESULT, makePreprocessing());

    expect(result.labelVerdict).toBe("FAIL");
    const abvRow = result.fields.find((row) => row.field === "alcohol_content");
    expect(abvRow?.verdict).toBe("MISMATCH");
    expect(abvRow?.reviewReason).toBeNull();
  });
});
