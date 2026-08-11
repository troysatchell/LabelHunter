import { describe, expect, it } from "vitest";
import { pickHeadlineReason, REVIEW_REASON_PRECEDENCE } from "./precedence";
import type { ReviewReason } from "./types";

describe("REVIEW_REASON_PRECEDENCE — CP-1 §5.2's exact rank order", () => {
  it("matches the eight reasons, in rank order", () => {
    expect(REVIEW_REASON_PRECEDENCE).toEqual([
      "LOW_IMAGE_QUALITY",
      "CONFLICTING_EXTRACTION",
      "MISSING_REQUIRED_FIELD",
      "WARNING_MISMATCH",
      "AMBIGUOUS_ABV",
      "AMBIGUOUS_NET_CONTENTS",
      "AMBIGUOUS_BRAND",
      "LOW_MODEL_CONFIDENCE",
    ]);
  });
});

describe("pickHeadlineReason", () => {
  it("returns null when nothing fired — a clean PASS", () => {
    expect(pickHeadlineReason(new Set())).toBeNull();
  });

  it("returns the single reason present", () => {
    expect(pickHeadlineReason(new Set<ReviewReason>(["AMBIGUOUS_BRAND"]))).toBe("AMBIGUOUS_BRAND");
  });

  it("picks LOW_IMAGE_QUALITY over CONFLICTING_EXTRACTION when both fired", () => {
    const reasons = new Set<ReviewReason>(["CONFLICTING_EXTRACTION", "LOW_IMAGE_QUALITY"]);
    expect(pickHeadlineReason(reasons)).toBe("LOW_IMAGE_QUALITY");
  });

  it("picks WARNING_MISMATCH over the AMBIGUOUS_* reasons (TH-R9 outranks judgment checks)", () => {
    const reasons = new Set<ReviewReason>(["AMBIGUOUS_BRAND", "AMBIGUOUS_ABV", "WARNING_MISMATCH"]);
    expect(pickHeadlineReason(reasons)).toBe("WARNING_MISMATCH");
  });

  it("picks LOW_MODEL_CONFIDENCE only when it is the sole reason — the residual bucket", () => {
    const reasons = new Set<ReviewReason>(["LOW_MODEL_CONFIDENCE"]);
    expect(pickHeadlineReason(reasons)).toBe("LOW_MODEL_CONFIDENCE");
  });
});
