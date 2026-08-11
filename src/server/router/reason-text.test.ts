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
    expect(buildFieldReasonText("NEEDS_REVIEW", null, undefined)).toBe("This field needs a closer look.");
  });
});
