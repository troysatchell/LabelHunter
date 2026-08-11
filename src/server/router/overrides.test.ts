import { describe, expect, it } from "vitest";
import type { ExtractedField, ExtractedGovernmentWarning } from "../extractor/types";
import { applyFieldOverrides, applyGovernmentWarningOverrides } from "./overrides";

function field(overrides: Partial<ExtractedField> = {}): ExtractedField {
  return { value: "45", evidence: "45% Alc./Vol.", confidence: 0.9, alternates: [], ...overrides };
}

function warning(overrides: Partial<ExtractedGovernmentWarning> = {}): ExtractedGovernmentWarning {
  return {
    present: true,
    transcription: "GOVERNMENT WARNING: text",
    prefix_casing: "ALL_CAPS",
    formatting: { bold: "uncertain" },
    evidence: "GOVERNMENT WARNING: text",
    confidence: 0.95,
    ...overrides,
  };
}

describe("applyFieldOverrides — rule 1: evidence present", () => {
  it("passes a field with a non-null value and non-empty evidence", () => {
    const outcome = applyFieldOverrides(field({ value: "Old Tom", evidence: "OLD TOM" }), "text");
    expect(outcome.rejected).toBe(false);
    expect(outcome.value).toBe("Old Tom");
  });

  it("rejects a non-null value with empty evidence — a contract violation, not an absent field", () => {
    const outcome = applyFieldOverrides(field({ value: "Old Tom", evidence: "" }), "text");
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("evidence_missing");
    expect(outcome.value).toBeNull();
  });

  it("does not reject a null value with empty evidence — that is a normal absent field", () => {
    const outcome = applyFieldOverrides(field({ value: null, evidence: "" }), "text");
    expect(outcome.rejected).toBe(false);
    expect(outcome.value).toBeNull();
  });
});

describe("applyFieldOverrides — rule 2: evidence supports value at a boundary (text fields)", () => {
  it("passes when the normalized value appears in the evidence at a word boundary", () => {
    const outcome = applyFieldOverrides(field({ value: "Old Tom", evidence: "Old Tom Distillery" }), "text");
    expect(outcome.rejected).toBe(false);
  });

  it("rejects a plain-substring match that is not at a word boundary — 'Tom' inside 'Tomintoul'", () => {
    const outcome = applyFieldOverrides(field({ value: "Tom", evidence: "Tomintoul Distillery" }), "text");
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("evidence_does_not_support_value");
  });

  it("rejects a hallucinated value the evidence never mentions", () => {
    const outcome = applyFieldOverrides(field({ value: "Moonshine Co", evidence: "OLD TOM DISTILLERY" }), "text");
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("evidence_does_not_support_value");
  });
});

describe("applyFieldOverrides — rule 2: evidence supports value (numeric ABV) — a plain substring is not enough", () => {
  it("passes when the evidence's parsed percent matches the value's", () => {
    const outcome = applyFieldOverrides(
      field({ value: "45% Alc./Vol.", evidence: "45% Alc./Vol. (90 Proof)" }),
      "numeric_abv",
    );
    expect(outcome.rejected).toBe(false);
  });

  it("rejects '45' claimed to be supported by evidence that actually says '145' — the named substring trap", () => {
    // normalize("45") is a substring of normalize("145"); CP-1 §4.4 names
    // this exact trap and requires a numeric parse, not a string search.
    const outcome = applyFieldOverrides(field({ value: "45%", evidence: "This bottle is 145% full of flavor." }), "numeric_abv");
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("evidence_does_not_support_value");
  });

  it("falls back to the word-boundary text check when the value itself does not parse numerically", () => {
    // AMBIGUOUS_ABV (field-resolution.ts) flags the parse failure on its
    // own; this override only guards against a hallucinated value.
    const outcome = applyFieldOverrides(field({ value: "unreadable", evidence: "unreadable smudge" }), "numeric_abv");
    expect(outcome.rejected).toBe(false);
  });

  it("supports a value stated as a percent when the evidence states only the equivalent proof — cross-axis, CodeRabbit finding", () => {
    // "45%" and "90 Proof" are the same reading on the canonical percent
    // scale (27 CFR 5.1). Before this fix, the check compared percent to
    // percent and proof to proof ONLY — never across axes — so a value
    // stated as a percent, evidenced only by a proof reading (e.g. the
    // extractor's own value/evidence split lands on different sides of the
    // same ABV statement), was wrongly rejected as unsupported.
    const outcome = applyFieldOverrides(field({ value: "45%", evidence: "90 Proof" }), "numeric_abv");
    expect(outcome.rejected).toBe(false);
  });

  it("still rejects a value whose canonical percent the evidence does not support, even across axes", () => {
    const outcome = applyFieldOverrides(field({ value: "45%", evidence: "150 Proof" }), "numeric_abv"); // 150 proof = 75%
    expect(outcome.rejected).toBe(true);
  });
});

describe("applyFieldOverrides — rule 2: evidence supports value (numeric net contents)", () => {
  it("passes when the evidence's parsed value and unit match the value's", () => {
    const outcome = applyFieldOverrides(field({ value: "750 mL", evidence: "750 mL" }), "numeric_net_contents");
    expect(outcome.rejected).toBe(false);
  });

  it("does not reject a value and evidence stated in different, but equivalent, units", () => {
    // CP-1 §5.3 compares the CONVERTED values, not the unit strings — "750
    // mL" and "0.75 L" describe the same quantity. Requiring the unit text
    // to match too would reject a genuinely well-evidenced field.
    const outcome = applyFieldOverrides(field({ value: "750 mL", evidence: "0.75 L" }), "numeric_net_contents");
    expect(outcome.rejected).toBe(false);
  });

  it("rejects evidence that supports a materially different quantity, even in a different unit", () => {
    const outcome = applyFieldOverrides(field({ value: "750 mL", evidence: "1 L" }), "numeric_net_contents");
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("evidence_does_not_support_value");
  });

  it("does not stop at the unit when the evidence runs two fields' text together", () => {
    const outcome = applyFieldOverrides(
      field({ value: "750 mL", evidence: "750 mL Alcohol 45%" }),
      "numeric_net_contents",
    );
    expect(outcome.rejected).toBe(false);
  });
});

describe("applyFieldOverrides — rule 2 exemption for beverage_type (TRO-502)", () => {
  it("does not reject an inferred category whose value is never verbatim in the evidence", () => {
    // beverage_type's value ("spirits") is an inferred category, never
    // verbatim in the label's evidence ("Straight Bourbon Whiskey") — a
    // known, ticketed exemption (TRO-502), not a general weakening of rule 2.
    const outcome = applyFieldOverrides(
      field({ value: "spirits", evidence: "Straight Bourbon Whiskey" }),
      "exempt",
    );
    expect(outcome.rejected).toBe(false);
    expect(outcome.value).toBe("spirits");
  });

  it("still rejects an exempt field with empty evidence (rule 1) or invalid confidence (rule 3)", () => {
    expect(applyFieldOverrides(field({ value: "spirits", evidence: "" }), "exempt").rejected).toBe(true);
    expect(applyFieldOverrides(field({ value: "spirits", confidence: Number.NaN }), "exempt").rejected).toBe(true);
  });
});

describe("applyFieldOverrides — rule 3: confidence must be a real number in [0, 1]", () => {
  it("rejects NaN, out-of-range, and never clamps", () => {
    const nanOutcome = applyFieldOverrides(field({ confidence: Number.NaN }), "text");
    expect(nanOutcome.rejected).toBe(true);
    expect(nanOutcome.violation).toBe("confidence_invalid");
    expect(nanOutcome.value).toBeNull();
    expect(nanOutcome.confidence).toBe(0); // not clamped to 1, discarded to 0 — see file doc comment

    const outOfRangeOutcome = applyFieldOverrides(field({ confidence: 1.5 }), "text");
    expect(outOfRangeOutcome.rejected).toBe(true);
    expect(outOfRangeOutcome.confidence).not.toBe(1.5);
  });

  it("checks confidence before evidence — an invalid confidence rejects even a well-evidenced field", () => {
    const outcome = applyFieldOverrides(field({ value: "Old Tom", evidence: "OLD TOM DISTILLERY", confidence: -1 }), "text");
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("confidence_invalid");
  });
});

describe("applyGovernmentWarningOverrides — field-shape-aware rejection payload", () => {
  it("rejects to present: null, transcription: null — not value: null, since the field has no value", () => {
    const outcome = applyGovernmentWarningOverrides(warning({ confidence: Number.NaN }));
    expect(outcome.rejected).toBe(true);
    expect(outcome.present).toBeNull();
    expect(outcome.transcription).toBeNull();
  });

  it("passes a present warning whose evidence supports its transcription", () => {
    const outcome = applyGovernmentWarningOverrides(warning());
    expect(outcome.rejected).toBe(false);
    expect(outcome.present).toBe(true);
    expect(outcome.transcription).toBe("GOVERNMENT WARNING: text");
  });

  it("does not reject a legitimately absent warning (present: false, transcription: null)", () => {
    const outcome = applyGovernmentWarningOverrides(
      warning({ present: false, transcription: null, evidence: "" }),
    );
    expect(outcome.rejected).toBe(false);
    expect(outcome.present).toBe(false);
    expect(outcome.transcription).toBeNull();
  });

  it("rejects a non-null transcription with empty evidence", () => {
    const outcome = applyGovernmentWarningOverrides(warning({ evidence: "" }));
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("evidence_missing");
  });

  it("rejects a transcription the evidence does not support", () => {
    const outcome = applyGovernmentWarningOverrides(
      warning({ transcription: "GOVERNMENT WARNING: something else entirely", evidence: "GOVERNMENT WARNING: text" }),
    );
    expect(outcome.rejected).toBe(true);
    expect(outcome.violation).toBe("evidence_does_not_support_value");
  });
});
