import { describe, expect, it } from "vitest";
import type { ApplicationRecord, ComparatorResult, FieldComparators } from "../../src/server/router/types";
import type { CorrectionFieldResolution, JudgedFieldResolution, ResolverResolution } from "../../src/server/resolver";
import { rollUpResolverResolution } from "./resolver-rollup";

const APPLICATION: ApplicationRecord = {
  beverageType: "spirits",
  brandName: "Old Tom Distillery",
  classType: "Straight Bourbon Whiskey",
  alcoholContentPercent: 45,
  netContentsValue: 750,
  netContentsUnit: "mL",
};

/** Numeric-only fake comparators — exact string equality against the
 * application value, MISMATCH otherwise. Deliberately simpler than the
 * real `productionComparators`; this file's tests are about the ROLLUP
 * logic (does a comparator's own verdict flow through correctly), not
 * about ABV/net-contents parsing, which has its own test suite. */
function fakeComparator(): (extracted: { value: string | null }, applicationValue: unknown) => ComparatorResult {
  return (extracted, applicationValue) => {
    if (extracted.value === null) return { verdict: "MISMATCH" };
    return extracted.value === String(applicationValue) ? { verdict: "MATCH" } : { verdict: "MISMATCH" };
  };
}

const FAKE_COMPARATORS: FieldComparators = {
  brand_name: fakeComparator() as FieldComparators["brand_name"],
  class_type: fakeComparator() as FieldComparators["class_type"],
  alcohol_content: fakeComparator() as FieldComparators["alcohol_content"],
  net_contents: fakeComparator() as FieldComparators["net_contents"],
};

const CANONICAL_WARNING =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

function judged(field: "brand_name" | "class_type", disposition: JudgedFieldResolution["disposition"]): JudgedFieldResolution {
  return { kind: "judged", field, disposition, correctedValue: disposition === "NEEDS_HUMAN" ? null : "x", evidence: "x", reason: "x", confidence: 0.9 };
}

function correction(
  field: "alcohol_content" | "net_contents" | "government_warning",
  overrides: Partial<CorrectionFieldResolution> = {},
): CorrectionFieldResolution {
  return {
    kind: "correction",
    field,
    needsHuman: false,
    correctedValue: "45",
    evidence: "x",
    reason: "x",
    confidence: 0.9,
    ...overrides,
  };
}

function allMatchResolution(): ResolverResolution {
  return {
    outcome: "resolved",
    fields: [
      judged("brand_name", "RESOLVED_MATCH"),
      judged("class_type", "RESOLVED_MATCH"),
      correction("alcohol_content", { correctedValue: "45" }),
      correction("net_contents", { correctedValue: "750 mL" }),
      correction("government_warning", { correctedValue: CANONICAL_WARNING }),
    ],
  };
}

describe("rollUpResolverResolution", () => {
  it("rolls up to PASS when every field resolves to MATCH", () => {
    const result = rollUpResolverResolution(allMatchResolution(), APPLICATION, FAKE_COMPARATORS);
    expect(result.labelVerdict).toBe("PASS");
    expect(result.fields.every((f) => f.verdict === "MATCH")).toBe(true);
    expect(result.headlineReason).toBeNull();
  });

  it("a judged field's RESOLVED_MATCH/RESOLVED_MISMATCH IS the field verdict directly (TH-R8)", () => {
    const resolution = allMatchResolution();
    resolution.fields[0] = judged("brand_name", "RESOLVED_MISMATCH");
    const result = rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS);
    expect(result.fields.find((f) => f.field === "brand_name")?.verdict).toBe("MISMATCH");
    expect(result.labelVerdict).toBe("FAIL");
  });

  it("a judged field's NEEDS_HUMAN rolls up to NEEDS_REVIEW and a REVIEW label", () => {
    const resolution = allMatchResolution();
    resolution.fields[0] = judged("brand_name", "NEEDS_HUMAN");
    const result = rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS);
    expect(result.fields.find((f) => f.field === "brand_name")?.verdict).toBe("NEEDS_REVIEW");
    expect(result.labelVerdict).toBe("REVIEW");
    expect(result.headlineReason).toBe("LOW_MODEL_CONFIDENCE");
  });

  it("a correction field's needsHuman rolls up to NEEDS_REVIEW without consulting the comparator", () => {
    const resolution = allMatchResolution();
    resolution.fields[2] = correction("alcohol_content", { needsHuman: true, correctedValue: null });
    const result = rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS);
    expect(result.fields.find((f) => f.field === "alcohol_content")?.verdict).toBe("NEEDS_REVIEW");
  });

  it("a correction field's corrected value re-runs the SAME deterministic comparator (CP-1 §6.5)", () => {
    const resolution = allMatchResolution();
    resolution.fields[2] = correction("alcohol_content", { correctedValue: "40" }); // disagrees with application's 45
    const result = rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS);
    expect(result.fields.find((f) => f.field === "alcohol_content")?.verdict).toBe("MISMATCH");
    expect(result.labelVerdict).toBe("FAIL");
  });

  it("a correction field with no filed application value (e.g. ABV omitted) rolls up to MATCH, not a fabricated REVIEW", () => {
    const applicationNoAbv: ApplicationRecord = { ...APPLICATION, alcoholContentPercent: undefined };
    const result = rollUpResolverResolution(allMatchResolution(), applicationNoAbv, FAKE_COMPARATORS);
    expect(result.fields.find((f) => f.field === "alcohol_content")?.verdict).toBe("MATCH");
  });

  it("government_warning reuses the real exact-comparison subsystem: exact canonical text -> MATCH", () => {
    const result = rollUpResolverResolution(allMatchResolution(), APPLICATION, FAKE_COMPARATORS);
    expect(result.fields.find((f) => f.field === "government_warning")?.verdict).toBe("MATCH");
  });

  it("government_warning: a confidently reworded transcription -> MISMATCH (2026-08-13 CP-2 amendment: certainty renders the verdict)", () => {
    // Superseded: this test previously asserted NEEDS_REVIEW ("single
    // channel never hard-fails"). Troy's TRO-581 ruling flipped the
    // single-channel table for structurally clean readings at confidence
    // >= 0.90 — the fixture's own 0.9 sits exactly at the threshold the
    // pass rule already trusted.
    const resolution = allMatchResolution();
    resolution.fields[4] = correction("government_warning", {
      correctedValue: CANONICAL_WARNING.replace("women should not drink", "women must never consume"),
    });
    const result = rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS);
    const field = result.fields.find((f) => f.field === "government_warning");
    expect(field?.verdict).toBe("MISMATCH");
  });

  it("government_warning: the same rewording BELOW 0.90 confidence still escalates to NEEDS_REVIEW with a real reviewReason", () => {
    const resolution = allMatchResolution();
    resolution.fields[4] = correction("government_warning", {
      correctedValue: CANONICAL_WARNING.replace("women should not drink", "women must never consume"),
      confidence: 0.7,
    });
    const result = rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS);
    const field = result.fields.find((f) => f.field === "government_warning");
    expect(field?.verdict).toBe("NEEDS_REVIEW");
    expect(result.headlineReason).toBe("WARNING_MISMATCH");
  });

  it("throws when the resolution is missing a required field", () => {
    const resolution = allMatchResolution();
    resolution.fields = resolution.fields.filter((f) => f.field !== "net_contents");
    expect(() => rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS)).toThrow(/no entry for "net_contents"/);
  });

  it("throws when the resolution has a duplicate field entry, rather than silently dropping one", () => {
    const resolution = allMatchResolution();
    resolution.fields.push(correction("net_contents", { correctedValue: "750 mL" }));
    expect(() => rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS)).toThrow(/duplicate field entries/);
  });

  it("throws rather than silently defaulting when a decided government_warning has a null correctedValue", () => {
    const resolution = allMatchResolution();
    resolution.fields[4] = correction("government_warning", { needsHuman: false, correctedValue: null });
    expect(() => rollUpResolverResolution(resolution, APPLICATION, FAKE_COMPARATORS)).toThrow(/null correctedValue/);
  });
});
