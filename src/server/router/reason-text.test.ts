import { describe, expect, it } from "vitest";
import { buildFieldReasonText } from "./reason-text";

describe("buildFieldReasonText", () => {
  it("prefers the comparator's own note over everything else", () => {
    expect(buildFieldReasonText("MISMATCH", "AMBIGUOUS_ABV", "A specific note.")).toBe("A specific note.");
  });

  it("falls back to a generic sentence keyed by the review reason", () => {
    expect(buildFieldReasonText("NEEDS_REVIEW", "MISSING_REQUIRED_FIELD", undefined)).toBe(
      "This field is required. The label did not show it.",
    );
  });

  it("a MISMATCH with no review reason reads as a mismatch, not a match", () => {
    expect(buildFieldReasonText("MISMATCH", null, undefined)).toBe("Does not match the application.");
  });

  it("a MATCH with no review reason reads as a match", () => {
    expect(buildFieldReasonText("MATCH", null, undefined)).toBe("Matches the application.");
  });

  it("a NEEDS_REVIEW with no review reason and no note does NOT read as a match", () => {
    // The regression case: CP-1 §5.3's own carve-out (LOW_IMAGE_QUALITY
    // suppresses MISSING_REQUIRED_FIELD) leaves exactly this combination —
    // NEEDS_REVIEW, reviewReason null, no comparator note. A verdict-only
    // fallback that only checks for "MISMATCH" would print "Matches the
    // application." here, which is wrong.
    expect(buildFieldReasonText("NEEDS_REVIEW", null, undefined)).toBe("A reviewer must check this field.");
  });

  it("never falls back to the vague 'needs a closer look' wording (TRO-480, standing rule 26)", () => {
    // Every REASON_TEXT_BY_REVIEW_REASON entry, plus the verdict-only
    // fallback above, used to end in "needs a closer look" — a phrase that
    // names no field and no action. Checked across every ReviewReason, not
    // just one, so a single re-added entry cannot slip through unnoticed.
    const reviewReasons = [
      "LOW_IMAGE_QUALITY",
      "CONFLICTING_EXTRACTION",
      "MISSING_REQUIRED_FIELD",
      "WARNING_MISMATCH",
      "AMBIGUOUS_ABV",
      "AMBIGUOUS_NET_CONTENTS",
      "AMBIGUOUS_BRAND",
      "LOW_MODEL_CONFIDENCE",
    ] as const;
    for (const reason of reviewReasons) {
      expect(buildFieldReasonText("NEEDS_REVIEW", reason, undefined)).not.toMatch(/closer look/i);
    }
    expect(buildFieldReasonText("NEEDS_REVIEW", null, undefined)).not.toMatch(/closer look/i);
  });
});
