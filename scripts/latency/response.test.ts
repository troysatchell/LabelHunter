/**
 * Tests for the latency harness's response-body validation (TRO-471 /
 * LH-031). Pure function, synthetic bodies only — no live call, no network.
 */
import { describe, expect, it } from "vitest";
import { parseVerifySuccessBody } from "./response";

describe("parseVerifySuccessBody", () => {
  it("accepts a well-formed body", () => {
    const body = { applicationId: 42, labelVerdict: "PASS", headlineReason: null };
    expect(parseVerifySuccessBody(body)).toEqual(body);
  });

  it("accepts a well-formed body with a non-null headlineReason", () => {
    const body = { applicationId: 1, labelVerdict: "REVIEW", headlineReason: "LOW_MODEL_CONFIDENCE" };
    expect(parseVerifySuccessBody(body)).toEqual(body);
  });

  it("rejects null", () => {
    expect(parseVerifySuccessBody(null)).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(parseVerifySuccessBody("not an object")).toBeNull();
    expect(parseVerifySuccessBody(42)).toBeNull();
  });

  it("rejects an empty object", () => {
    expect(parseVerifySuccessBody({})).toBeNull();
  });

  it("rejects a missing applicationId", () => {
    expect(parseVerifySuccessBody({ labelVerdict: "PASS", headlineReason: null })).toBeNull();
  });

  it("rejects a non-numeric applicationId", () => {
    expect(parseVerifySuccessBody({ applicationId: "42", labelVerdict: "PASS", headlineReason: null })).toBeNull();
  });

  it("rejects a missing labelVerdict", () => {
    expect(parseVerifySuccessBody({ applicationId: 1, headlineReason: null })).toBeNull();
  });

  it("rejects a non-string labelVerdict", () => {
    expect(parseVerifySuccessBody({ applicationId: 1, labelVerdict: 1, headlineReason: null })).toBeNull();
  });

  it("rejects a headlineReason that is neither null nor a string", () => {
    expect(parseVerifySuccessBody({ applicationId: 1, labelVerdict: "PASS", headlineReason: 1 })).toBeNull();
  });

  it("rejects a missing headlineReason — the field must be explicitly present", () => {
    expect(parseVerifySuccessBody({ applicationId: 1, labelVerdict: "PASS" })).toBeNull();
  });
});
