import { describe, expect, it } from "vitest";
import {
  classifyConfidenceBand,
  getTrustedThreshold,
  isValidConfidence,
  MATCH_ESCALATION_CEILING,
  MISMATCH_ESCALATION_CEILING,
  shouldEscalateField,
  TRUSTED_THRESHOLD_DEFAULT,
  TRUSTED_THRESHOLD_WARNING_TRANSCRIPTION,
  UNUSABLE_CEILING,
} from "./confidence";

describe("getTrustedThreshold — CP-1 §4.2's one field override", () => {
  it("uses 0.90 for the government warning", () => {
    expect(getTrustedThreshold("government_warning")).toBe(TRUSTED_THRESHOLD_WARNING_TRANSCRIPTION);
    expect(getTrustedThreshold("government_warning")).toBe(0.9);
  });

  it("uses 0.85 for every other field", () => {
    for (const field of ["brand_name", "class_type", "alcohol_content", "net_contents"] as const) {
      expect(getTrustedThreshold(field)).toBe(TRUSTED_THRESHOLD_DEFAULT);
      expect(getTrustedThreshold(field)).toBe(0.85);
    }
  });
});

describe("classifyConfidenceBand — CP-1 §4.2's three bands", () => {
  it("below 0.60 is unusable, regardless of the trusted threshold", () => {
    expect(classifyConfidenceBand(0.59, 0.85)).toBe("unusable");
    expect(classifyConfidenceBand(0, 0.9)).toBe("unusable");
  });

  it("between 0.60 and the trusted threshold is uncertain", () => {
    expect(classifyConfidenceBand(0.6, 0.85)).toBe("uncertain");
    expect(classifyConfidenceBand(0.84, 0.85)).toBe("uncertain");
    expect(classifyConfidenceBand(0.89, 0.9)).toBe("uncertain");
  });

  it("at or above the trusted threshold is trusted", () => {
    expect(classifyConfidenceBand(0.85, 0.85)).toBe("trusted");
    expect(classifyConfidenceBand(0.9, 0.9)).toBe("trusted");
    expect(classifyConfidenceBand(1, 0.85)).toBe("trusted");
  });
});

describe("isValidConfidence — CP-1 §4.4 rule 3", () => {
  it("accepts every real number in [0, 1]", () => {
    expect(isValidConfidence(0)).toBe(true);
    expect(isValidConfidence(1)).toBe(true);
    expect(isValidConfidence(0.5)).toBe(true);
  });

  it("rejects NaN, out-of-range numbers, and non-finite numbers", () => {
    expect(isValidConfidence(Number.NaN)).toBe(false);
    expect(isValidConfidence(1.5)).toBe(false);
    expect(isValidConfidence(-0.2)).toBe(false);
    expect(isValidConfidence(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("shouldEscalateField — the asymmetry rule (CP-1 §4.3)", () => {
  it("MATCH escalates only below the unusable ceiling (0.60)", () => {
    expect(shouldEscalateField("MATCH", 0.59)).toBe(true);
    expect(shouldEscalateField("MATCH", MATCH_ESCALATION_CEILING)).toBe(false);
    // A MATCH in the Uncertain band (0.60-0.85) does NOT escalate — the
    // agreement corroborates the low-confidence read (CP-1 §4.3).
    expect(shouldEscalateField("MATCH", 0.7)).toBe(false);
    expect(shouldEscalateField("MATCH", 0.99)).toBe(false);
  });

  it("MISMATCH escalates below 0.90 — a higher bar than MATCH's", () => {
    expect(shouldEscalateField("MISMATCH", 0.89)).toBe(true);
    expect(shouldEscalateField("MISMATCH", MISMATCH_ESCALATION_CEILING)).toBe(false);
    expect(shouldEscalateField("MISMATCH", 0.99)).toBe(false);
    // Below the unusable ceiling too — MISMATCH is strictly stricter than MATCH.
    expect(shouldEscalateField("MISMATCH", 0.1)).toBe(true);
  });

  it("NEEDS_REVIEW always escalates, at any confidence", () => {
    expect(shouldEscalateField("NEEDS_REVIEW", 0)).toBe(true);
    expect(shouldEscalateField("NEEDS_REVIEW", 0.99)).toBe(true);
    expect(shouldEscalateField("NEEDS_REVIEW", UNUSABLE_CEILING)).toBe(true);
  });
});
