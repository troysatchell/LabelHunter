import { describe, expect, it } from "vitest";
import { parseFullVerifySuccessBody } from "./response-validation";

function validField(overrides: Record<string, unknown> = {}) {
  return {
    field: "brand_name",
    verdict: "MATCH",
    labelValue: "Old Tom Distillery",
    evidence: "Old Tom Distillery",
    reason: "matches",
    reviewReason: null,
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: 1,
    verificationId: 2,
    labelVerdict: "PASS",
    headlineReason: null,
    fields: [
      validField({ field: "brand_name" }),
      validField({ field: "class_type" }),
      validField({ field: "alcohol_content" }),
      validField({ field: "net_contents" }),
      validField({ field: "government_warning" }),
    ],
    ...overrides,
  };
}

describe("parseFullVerifySuccessBody", () => {
  it("accepts a well-formed body", () => {
    const result = parseFullVerifySuccessBody(validBody());
    expect(result).not.toBeNull();
    expect(result?.fields).toHaveLength(5);
  });

  it("rejects a non-object body", () => {
    expect(parseFullVerifySuccessBody(null)).toBeNull();
    expect(parseFullVerifySuccessBody("a string")).toBeNull();
  });

  it("rejects a zero or negative applicationId", () => {
    expect(parseFullVerifySuccessBody(validBody({ applicationId: 0 }))).toBeNull();
    expect(parseFullVerifySuccessBody(validBody({ applicationId: -1 }))).toBeNull();
  });

  it("rejects an invalid labelVerdict", () => {
    expect(parseFullVerifySuccessBody(validBody({ labelVerdict: "MAYBE" }))).toBeNull();
  });

  it("rejects a headlineReason not in the ReviewReason enum", () => {
    expect(parseFullVerifySuccessBody(validBody({ headlineReason: "BOGUS_REASON" }))).toBeNull();
  });

  it("accepts a non-null headlineReason from the real enum", () => {
    const body = validBody({ labelVerdict: "REVIEW", headlineReason: "LOW_IMAGE_QUALITY" });
    expect(parseFullVerifySuccessBody(body)).not.toBeNull();
  });

  it("rejects a body missing one of the five required fields", () => {
    const body = validBody({
      fields: [
        validField({ field: "brand_name" }),
        validField({ field: "class_type" }),
        validField({ field: "alcohol_content" }),
        validField({ field: "net_contents" }),
        // government_warning missing
      ],
    });
    expect(parseFullVerifySuccessBody(body)).toBeNull();
  });

  it("rejects a field with an invalid verdict", () => {
    // All five required fields present and otherwise valid, so rejection
    // is isolated to the one bad verdict value — not a side effect of the
    // separate "all five fields present" check.
    const body = validBody({
      fields: [
        validField({ field: "brand_name", verdict: "SOMETHING_ELSE" }),
        validField({ field: "class_type" }),
        validField({ field: "alcohol_content" }),
        validField({ field: "net_contents" }),
        validField({ field: "government_warning" }),
      ],
    });
    expect(parseFullVerifySuccessBody(body)).toBeNull();
  });

  it("rejects a body with a duplicate field entry, even though every required key is still present", () => {
    const body = validBody({
      fields: [
        validField({ field: "brand_name" }),
        validField({ field: "brand_name" }), // duplicate, in place of class_type
        validField({ field: "alcohol_content" }),
        validField({ field: "net_contents" }),
        validField({ field: "government_warning" }),
      ],
    });
    expect(parseFullVerifySuccessBody(body)).toBeNull();
  });

  it("accepts a null labelValue on a field", () => {
    const body = validBody({
      fields: [
        validField({ field: "brand_name", labelValue: null }),
        validField({ field: "class_type" }),
        validField({ field: "alcohol_content" }),
        validField({ field: "net_contents" }),
        validField({ field: "government_warning" }),
      ],
    });
    expect(parseFullVerifySuccessBody(body)).not.toBeNull();
  });
});
