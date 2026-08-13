/**
 * Tests for `http-error.ts` (TRO-539). Pure, no I/O, no live call, no
 * real money, no real timer.
 */
import { describe, expect, it } from "vitest";
import { describeHttpError } from "./http-error";

describe("describeHttpError", () => {
  it("reports a timeout, naming the configured ms, when wasAborted is true", () => {
    const message = describeHttpError(new Error("This operation was aborted"), true, 30_000);
    expect(message).toMatch(/timed out after 30000ms/);
    expect(message).toMatch(/hung or unreachable/);
  });

  it("reports a timeout even when the caught value is not an Error instance", () => {
    expect(describeHttpError("some non-Error abort reason", true, 5_000)).toMatch(/timed out after 5000ms/);
  });

  it("reports the real Error message when wasAborted is false", () => {
    expect(describeHttpError(new Error("ECONNREFUSED"), false, 30_000)).toBe("ECONNREFUSED");
  });

  it("stringifies a non-Error cause when wasAborted is false", () => {
    expect(describeHttpError("connection reset", false, 30_000)).toBe("connection reset");
  });

  it("never throws", () => {
    expect(() => describeHttpError(undefined, false, 30_000)).not.toThrow();
    expect(() => describeHttpError(null, true, 30_000)).not.toThrow();
  });

  // CodeRabbit local review round 2 (minor): String() on a null-prototype
  // object throws for real -- it has no toString anywhere in its (empty)
  // prototype chain. Confirmed directly here, not assumed.
  it("does not throw when String(cause) itself would throw (a null-prototype cause)", () => {
    const nullProtoCause = Object.create(null) as unknown;
    expect(() => String(nullProtoCause)).toThrow(); // the premise this test protects against, proven first
    expect(() => describeHttpError(nullProtoCause, false, 30_000)).not.toThrow();
    expect(describeHttpError(nullProtoCause, false, 30_000)).toMatch(/could not be converted to a string/);
  });
});
