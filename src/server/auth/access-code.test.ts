/**
 * Tests for the shared access-code gate's pure logic (TRO-482 / LH-061,
 * PRD §8, escalation.md rule 7). Written first, per PRD §6's TDD mandate.
 *
 * Every hash/compare function here is async — see `access-code.ts`'s own
 * header comment: `src/proxy.ts` runs in Next's Edge Runtime, which does
 * not support `node:crypto`, so this module uses the Web Crypto API
 * (`crypto.subtle`), whose digest call is Promise-based.
 *
 * `ACCESS_CODE` is set/restored around every test that reads it — standing
 * rule 18: the header/cookie value is untrusted input from the boundary,
 * validated explicitly here, never assumed shaped correctly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_CODE_COOKIE_NAME,
  ACCESS_CODE_HEADER_NAME,
  constantTimeEquals,
  hasValidAccessCode,
  isValidAccessCode,
  readCookieValue,
} from "./access-code";

const ORIGINAL_ACCESS_CODE = process.env.ACCESS_CODE;

function restoreAccessCode() {
  if (ORIGINAL_ACCESS_CODE === undefined) delete process.env.ACCESS_CODE;
  else process.env.ACCESS_CODE = ORIGINAL_ACCESS_CODE;
}

describe("constantTimeEquals — pure (async: Web Crypto's digest is Promise-based)", () => {
  it("is true for identical strings", async () => {
    expect(await constantTimeEquals("open-sesame", "open-sesame")).toBe(true);
  });

  it("is false for different strings of the same length", async () => {
    expect(await constantTimeEquals("open-sesame", "open-sesamf")).toBe(false);
  });

  it("is false for strings of different lengths — never throws", async () => {
    await expect(constantTimeEquals("short", "a-much-longer-value")).resolves.toBe(false);
  });

  it("is false against an empty string, and true for two empty strings", async () => {
    expect(await constantTimeEquals("open-sesame", "")).toBe(false);
    expect(await constantTimeEquals("", "")).toBe(true);
  });
});

describe("readCookieValue — pure, synchronous (no hashing involved)", () => {
  it("reads a named cookie's value out of a Cookie header", () => {
    expect(readCookieValue("a=1; lh_access_code=secret-value; b=2", "lh_access_code")).toBe("secret-value");
  });

  it("returns null when the header is absent", () => {
    expect(readCookieValue(null, "lh_access_code")).toBeNull();
  });

  it("returns null when the named cookie is not present", () => {
    expect(readCookieValue("a=1; b=2", "lh_access_code")).toBeNull();
  });

  it("decodes a percent-encoded value", () => {
    expect(readCookieValue("lh_access_code=a%20code%20with%20spaces", "lh_access_code")).toBe("a code with spaces");
  });

  it("trims incidental whitespace around each cookie pair", () => {
    expect(readCookieValue("  a=1 ;  lh_access_code=secret-value  ", "lh_access_code")).toBe("secret-value");
  });
});

describe("isValidAccessCode — reads process.env.ACCESS_CODE", () => {
  beforeEach(() => {
    process.env.ACCESS_CODE = "correct-horse-battery-staple";
  });
  afterEach(restoreAccessCode);

  it("is true for the exact configured code", async () => {
    expect(await isValidAccessCode("correct-horse-battery-staple")).toBe(true);
  });

  it("is false for a wrong code", async () => {
    expect(await isValidAccessCode("wrong-code")).toBe(false);
  });

  it("is false for null, undefined, or an empty candidate", async () => {
    expect(await isValidAccessCode(null)).toBe(false);
    expect(await isValidAccessCode(undefined)).toBe(false);
    expect(await isValidAccessCode("")).toBe(false);
  });

  it("fails CLOSED — every candidate is rejected when ACCESS_CODE is not configured", async () => {
    delete process.env.ACCESS_CODE;
    expect(await isValidAccessCode("correct-horse-battery-staple")).toBe(false);
    expect(await isValidAccessCode("anything")).toBe(false);
  });

  it("fails CLOSED when ACCESS_CODE is configured as an empty string", async () => {
    process.env.ACCESS_CODE = "";
    expect(await isValidAccessCode("")).toBe(false);
  });
});

describe("hasValidAccessCode — checks the header and the cookie", () => {
  beforeEach(() => {
    process.env.ACCESS_CODE = "correct-horse-battery-staple";
  });
  afterEach(restoreAccessCode);

  function requestWith(opts: { header?: string; cookie?: string }): Request {
    const headers = new Headers();
    if (opts.header !== undefined) headers.set(ACCESS_CODE_HEADER_NAME, opts.header);
    if (opts.cookie !== undefined) headers.set("cookie", `${ACCESS_CODE_COOKIE_NAME}=${opts.cookie}`);
    return new Request("http://localhost/api/verify", { headers });
  }

  it("is true when the x-access-code header carries the correct code — non-browser callers", async () => {
    expect(await hasValidAccessCode(requestWith({ header: "correct-horse-battery-staple" }))).toBe(true);
  });

  it("is true when the cookie carries the correct code — the browser flow", async () => {
    expect(await hasValidAccessCode(requestWith({ cookie: "correct-horse-battery-staple" }))).toBe(true);
  });

  it("is false when neither the header nor the cookie is present", async () => {
    expect(await hasValidAccessCode(requestWith({}))).toBe(false);
  });

  it("is false when the header is present but wrong", async () => {
    expect(await hasValidAccessCode(requestWith({ header: "wrong" }))).toBe(false);
  });

  it("is false when the cookie is present but wrong", async () => {
    expect(await hasValidAccessCode(requestWith({ cookie: "wrong" }))).toBe(false);
  });

  it("is true when the header is wrong but the cookie is correct — either credential is sufficient", async () => {
    expect(await hasValidAccessCode(requestWith({ header: "wrong", cookie: "correct-horse-battery-staple" }))).toBe(true);
  });
});
