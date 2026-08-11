import { describe, expect, it } from "vitest";
import { isFieldAbsent, type FieldState } from "./field-state";

function state(overrides: Partial<FieldState> = {}): FieldState {
  return {
    field: "brand_name",
    requirement: "required",
    required: true,
    value: "Old Tom",
    present: null,
    evidence: "OLD TOM",
    confidence: 0.95,
    overrideRejected: false,
    ...overrides,
  };
}

describe("isFieldAbsent — the field-shape-aware absence check (CP-1 §5.3)", () => {
  it("checks value === null for the five value/evidence/confidence fields", () => {
    expect(isFieldAbsent(state({ value: null }))).toBe(true);
    expect(isFieldAbsent(state({ value: "Old Tom" }))).toBe(false);
  });

  it("checks present, not value, for government_warning — it has no value at all", () => {
    // A uniform `value === null` check would never fire here: `value` on a
    // government_warning FieldState is always null by construction (the
    // field has no value), so a value-only check would silently treat
    // every warning as absent, or never notice a genuinely absent one,
    // depending on how it were written. This checks `present` instead.
    const warningState = state({ field: "government_warning", value: null, present: true });
    expect(isFieldAbsent(warningState)).toBe(false);

    const absentByFalse = state({ field: "government_warning", value: null, present: false });
    expect(isFieldAbsent(absentByFalse)).toBe(true);

    const absentByNull = state({ field: "government_warning", value: null, present: null });
    expect(isFieldAbsent(absentByNull)).toBe(true);
  });
});
