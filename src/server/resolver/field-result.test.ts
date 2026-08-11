import { describe, expect, it } from "vitest";
import { toJudgedFieldResultRow } from "./field-result";
import type { JudgedFieldResolution } from "./types";

function judgedResolution(overrides: Partial<JudgedFieldResolution> = {}): JudgedFieldResolution {
  return {
    kind: "judged",
    field: "brand_name",
    disposition: "RESOLVED_MATCH",
    correctedValue: "Stone's Throw",
    evidence: "STONE'S THROW",
    reason: "The label reads Stone's Throw, matching the application.",
    confidence: 0.95,
    ...overrides,
  };
}

describe("toJudgedFieldResultRow — the discriminated-union legality (../router/types.ts FieldResultRow)", () => {
  it("sets resolvedBy: 'sonnet' and carries the reviewReason forward on RESOLVED_MATCH", () => {
    const row = toJudgedFieldResultRow(judgedResolution(), "AMBIGUOUS_BRAND", "Stone's Throw");
    expect(row.verdict).toBe("MATCH");
    expect(row.resolvedBy).toBe("sonnet");
    expect(row.reviewReason).toBe("AMBIGUOUS_BRAND");
    expect(row.labelValue).toBe("Stone's Throw");
    expect(row.evidence).toBe("STONE'S THROW");
    expect(row.reason).toBe("The label reads Stone's Throw, matching the application.");
  });

  it("sets resolvedBy: 'sonnet' and verdict MISMATCH on RESOLVED_MISMATCH", () => {
    const row = toJudgedFieldResultRow(
      judgedResolution({ disposition: "RESOLVED_MISMATCH", correctedValue: "Northwind Cellars" }),
      "AMBIGUOUS_BRAND",
      "Stone's Throw",
    );
    expect(row.verdict).toBe("MISMATCH");
    expect(row.resolvedBy).toBe("sonnet");
    expect(row.reviewReason).toBe("AMBIGUOUS_BRAND");
  });

  it("sets resolvedBy: null and verdict NEEDS_REVIEW on NEEDS_HUMAN — nobody has resolved this field yet", () => {
    const row = toJudgedFieldResultRow(
      judgedResolution({ disposition: "NEEDS_HUMAN", correctedValue: null }),
      "AMBIGUOUS_BRAND",
      "Stone's Throw",
    );
    expect(row.verdict).toBe("NEEDS_REVIEW");
    expect(row.resolvedBy).toBeNull();
    // The discriminated union's unresolved branch still requires reviewReason
    // to be preserved (it can be non-null there) — a field awaiting a human
    // must not lose the reason it is waiting.
    expect(row.reviewReason).toBe("AMBIGUOUS_BRAND");
  });

  it("never constructs the illegal state resolvedBy: 'sonnet' with reviewReason: null", () => {
    // Every branch above threads a real ReviewReason through — there is no
    // code path in this function that can produce resolvedBy: "sonnet"
    // without one, matching FieldResultRow's discriminated union.
    for (const disposition of ["RESOLVED_MATCH", "RESOLVED_MISMATCH", "NEEDS_HUMAN"] as const) {
      const row = toJudgedFieldResultRow(judgedResolution({ disposition }), "AMBIGUOUS_BRAND", "x");
      if (row.resolvedBy !== null) {
        expect(row.reviewReason).not.toBeNull();
      }
    }
  });

  it("works identically for class_type", () => {
    const row = toJudgedFieldResultRow(
      judgedResolution({ field: "class_type", correctedValue: "Straight Bourbon Whiskey" }),
      "AMBIGUOUS_BRAND",
      "Straight Bourbon Whiskey",
    );
    expect(row.field).toBe("class_type");
    expect(row.verdict).toBe("MATCH");
  });
});
