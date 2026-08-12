import { describe, expect, it } from "vitest";
import {
  BEVERAGE_TYPES,
  REVIEW_DISPOSITIONS,
  REVIEW_REASONS,
  assertEnumMember,
  toBeverageType,
  toReviewDisposition,
  toReviewReason,
} from "./enums";

describe("toReviewReason", () => {
  it("returns the value unchanged when it is a valid ReviewReason", () => {
    for (const reason of REVIEW_REASONS) {
      expect(toReviewReason(reason)).toBe(reason);
    }
  });

  it("throws on a value outside the ReviewReason set", () => {
    expect(() => toReviewReason("NOT_A_REAL_REASON")).toThrow(
      /toReviewReason: "NOT_A_REAL_REASON" is not one of/,
    );
  });

  it("throws on a near-miss (wrong case) instead of silently accepting it", () => {
    // A model or CSV producing lowercase text is a real failure mode this
    // guard exists to catch — it must not pass through as valid.
    expect(() => toReviewReason("low_image_quality")).toThrow();
  });

  it("lists every legal value in the error message", () => {
    try {
      toReviewReason("BOGUS");
      throw new Error("expected toReviewReason to throw");
    } catch (err) {
      const message = (err as Error).message;
      for (const reason of REVIEW_REASONS) {
        expect(message).toContain(reason);
      }
    }
  });
});

describe("toBeverageType", () => {
  it("returns the value unchanged when it is a valid BeverageType", () => {
    for (const type of BEVERAGE_TYPES) {
      expect(toBeverageType(type)).toBe(type);
    }
  });

  it("throws on a value outside the BeverageType set", () => {
    expect(() => toBeverageType("cider")).toThrow(
      /toBeverageType: "cider" is not one of/,
    );
  });

  it("throws on a near-miss (wrong case) instead of silently accepting it", () => {
    expect(() => toBeverageType("Beer")).toThrow();
  });
});

describe("toReviewDisposition", () => {
  it("returns the value unchanged when it is a valid ReviewDisposition", () => {
    for (const disposition of REVIEW_DISPOSITIONS) {
      expect(toReviewDisposition(disposition)).toBe(disposition);
    }
  });

  it("throws on a value outside the ReviewDisposition set", () => {
    expect(() => toReviewDisposition("MAYBE")).toThrow(
      /toReviewDisposition: "MAYBE" is not one of/,
    );
  });

  it("throws on a near-miss (wrong case) instead of silently accepting it", () => {
    // The review-queue action endpoint (TRO-476) reads this from an HTTP
    // JSON body — untrusted input, same failure mode toReviewReason's own
    // near-miss test guards against.
    expect(() => toReviewDisposition("approved")).toThrow();
  });
});

describe("assertEnumMember", () => {
  it("narrows a valid value against an arbitrary closed set", () => {
    const colors = ["red", "green", "blue"] as const;
    expect(assertEnumMember(colors, "green", "color")).toBe("green");
  });

  it("throws with the caller-supplied label so the source is identifiable", () => {
    const colors = ["red", "green", "blue"] as const;
    expect(() => assertEnumMember(colors, "purple", "color")).toThrow(/^color:/);
  });
});
