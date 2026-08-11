import { describe, expect, it } from "vitest";
import { rollupLabelVerdict } from "./rollup";

describe("rollupLabelVerdict — CP-1 §5.4, exact rollup", () => {
  it("a label-level blocker outranks every field verdict, even an all-clean field set", () => {
    expect(rollupLabelVerdict(true, ["MATCH", "MATCH", "MATCH"])).toBe("REVIEW");
  });

  it("a label-level blocker outranks a field-level MISMATCH too — REVIEW, not FAIL", () => {
    // A FAIL is a claim the agency acts on; the router does not make that
    // claim while any part of the reading is unresolved (TH-R10).
    expect(rollupLabelVerdict(true, ["MISMATCH"])).toBe("REVIEW");
  });

  it("any field NEEDS_REVIEW makes the label REVIEW", () => {
    expect(rollupLabelVerdict(false, ["MATCH", "NEEDS_REVIEW", "MISMATCH"])).toBe("REVIEW");
  });

  it("REVIEW outranks FAIL: one certain mismatch plus one unclear field is still REVIEW, not FAIL", () => {
    expect(rollupLabelVerdict(false, ["MISMATCH", "NEEDS_REVIEW"])).toBe("REVIEW");
  });

  it("any field MISMATCH (with no NEEDS_REVIEW and no blocker) makes the label FAIL", () => {
    expect(rollupLabelVerdict(false, ["MATCH", "MISMATCH"])).toBe("FAIL");
  });

  it("all fields MATCH, no blocker: PASS", () => {
    expect(rollupLabelVerdict(false, ["MATCH", "MATCH", "MATCH", "MATCH", "MATCH"])).toBe("PASS");
  });

  it("no fields at all, no blocker: PASS (vacuous)", () => {
    expect(rollupLabelVerdict(false, [])).toBe("PASS");
  });
});
