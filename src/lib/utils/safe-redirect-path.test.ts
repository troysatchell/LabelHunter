/**
 * Tests for `sanitizeRedirectPath` (TRO-565 finding 1). Written first, per
 * PRD §6's TDD mandate — `safe-redirect-path.ts` does not exist until this
 * ticket adds it.
 */
import { describe, expect, it } from "vitest";
import { sanitizeRedirectPath } from "./safe-redirect-path";

describe("sanitizeRedirectPath", () => {
  it("accepts a real, path-relative destination", () => {
    expect(sanitizeRedirectPath("/verify")).toBe("/verify");
  });

  it("accepts a path-relative destination that carries a query string", () => {
    expect(sanitizeRedirectPath("/verify?id=3")).toBe("/verify?id=3");
  });

  it("falls back to / on null, undefined, or an empty string", () => {
    expect(sanitizeRedirectPath(null)).toBe("/");
    expect(sanitizeRedirectPath(undefined)).toBe("/");
    expect(sanitizeRedirectPath("")).toBe("/");
  });

  it("rejects an absolute URL with a scheme", () => {
    expect(sanitizeRedirectPath("https://evil.com")).toBe("/");
    expect(sanitizeRedirectPath("http://evil.com/verify")).toBe("/");
    expect(sanitizeRedirectPath("javascript:alert(1)")).toBe("/");
  });

  it("rejects a protocol-relative URL (a leading //)", () => {
    expect(sanitizeRedirectPath("//evil.com")).toBe("/");
    expect(sanitizeRedirectPath("//evil.com/verify")).toBe("/");
  });

  it("rejects a backslash-prefixed path some URL parsers treat as protocol-relative", () => {
    expect(sanitizeRedirectPath("/\\evil.com")).toBe("/");
  });

  it("rejects a bare host with no leading slash", () => {
    expect(sanitizeRedirectPath("evil.com")).toBe("/");
  });
});
