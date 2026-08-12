/**
 * Tests for `POST /api/access-code` (TRO-482 / LH-061, PRD §8). Written
 * first, per PRD §6's TDD mandate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_CODE_COOKIE_MAX_AGE_SECONDS, ACCESS_CODE_COOKIE_NAME } from "../../../server/auth/access-code";
import { POST } from "./route";

const REAL_CODE = "correct-horse-battery-staple";
const ORIGINAL_ACCESS_CODE = process.env.ACCESS_CODE;

beforeEach(() => {
  process.env.ACCESS_CODE = REAL_CODE;
});
afterEach(() => {
  if (ORIGINAL_ACCESS_CODE === undefined) delete process.env.ACCESS_CODE;
  else process.env.ACCESS_CODE = ORIGINAL_ACCESS_CODE;
});

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/access-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/access-code", () => {
  it("accepts the correct code and sets a long-lived httpOnly cookie", async () => {
    const response = await POST(postJson({ code: REAL_CODE }));
    expect(response.status).toBe(200);

    const cookie = response.cookies.get(ACCESS_CODE_COOKIE_NAME);
    expect(cookie?.value).toBe(REAL_CODE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toMatch(/lax/i);
    expect(cookie?.path).toBe("/");
    expect(cookie?.maxAge).toBe(ACCESS_CODE_COOKIE_MAX_AGE_SECONDS);
  });

  it("rejects a wrong code with 401 and a friendly message — no cookie set", async () => {
    const response = await POST(postJson({ code: "wrong-code" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(response.cookies.get(ACCESS_CODE_COOKIE_NAME)).toBeUndefined();
  });

  it("rejects a missing code field with 401, not a 500 — malformed input is not a server error", async () => {
    const response = await POST(postJson({}));
    expect(response.status).toBe(401);
  });

  it("rejects a non-string code field", async () => {
    const response = await POST(postJson({ code: 12345 }));
    expect(response.status).toBe(401);
  });

  it("rejects an unparseable JSON body with 400, not a crash", async () => {
    const request = new Request("http://localhost/api/access-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("fails closed — rejects even the string 'undefined' when ACCESS_CODE itself is unset", async () => {
    delete process.env.ACCESS_CODE;
    const response = await POST(postJson({ code: REAL_CODE }));
    expect(response.status).toBe(401);
  });

  it("never echoes the submitted code back in the response body", async () => {
    const response = await POST(postJson({ code: "wrong-code-should-not-appear" }));
    const text = await response.text();
    expect(text).not.toContain("wrong-code-should-not-appear");
  });
});
