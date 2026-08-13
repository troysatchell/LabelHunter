/**
 * Tests for `POST /api/access-code` (TRO-482 / LH-061, PRD §8). Written
 * first, per PRD §6's TDD mandate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_CODE_COOKIE_MAX_AGE_SECONDS, ACCESS_CODE_COOKIE_NAME } from "../../../server/auth/access-code";
import { createFixedWindowLimiter } from "../../../server/rate-limit/fixed-window";
import {
  ACCESS_CODE_IP_LIMIT,
  ACCESS_CODE_IP_WINDOW_MS,
  checkRateLimitPair,
  formatAccessCodeRateLimitMessage,
} from "../../../server/rate-limit/instances";
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

/** Same request, with a client address the per-IP limiter can key on
 * (`getClientIp` reads `x-forwarded-for`). */
function withIp(request: Request, ip: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-for", ip);
  return new Request(request, { headers });
}

/** A global limiter big enough that it never fires, so a per-IP test
 * asserts the per-IP bound and nothing else. */
function neverFullGlobalLimiter() {
  return createFixedWindowLimiter({ limit: Number.MAX_SAFE_INTEGER, windowMs: ACCESS_CODE_IP_WINDOW_MS });
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

/**
 * The brute-force bound (TRO-482, merge review round 1).
 *
 * `/api/access-code` is the one endpoint `src/proxy.ts` exempts from the
 * gate, so anyone can reach it with no credential. That is what makes it
 * the place an attacker guesses the shared code, and the constant-time
 * comparison in `isValidAccessCode` is worth nothing if the guessing is
 * unlimited. These tests cover the limit that makes it worth something.
 */
describe("POST /api/access-code — brute-force limit", () => {
  it("rejects attempt N+1 from one IP, with a friendly message and no cookie", async () => {
    // A limiter this test owns, not the shared production singleton — so
    // the assertion is about the ROUTE consuming a limiter correctly, and
    // it cannot be skewed by another test's attempts.
    const limiter = createFixedWindowLimiter({ limit: ACCESS_CODE_IP_LIMIT, windowMs: ACCESS_CODE_IP_WINDOW_MS });
    const check = (request: Request) => checkRateLimitPair(request, limiter, neverFullGlobalLimiter(), formatAccessCodeRateLimitMessage);
    const attempt = () => POST(withIp(postJson({ code: "wrong" }), "198.51.100.7"), check);

    for (let i = 0; i < ACCESS_CODE_IP_LIMIT; i += 1) {
      // Every attempt inside the limit still fails on the code itself.
      expect((await attempt()).status).toBe(401);
    }

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/too many access code attempts/i);
    expect(body.error.message).toMatch(/minute/);
    expect(blocked.cookies.get(ACCESS_CODE_COOKIE_NAME)).toBeUndefined();
  });

  it("counts a CORRECT code against the limit too, so a guesser cannot keep going after landing one", async () => {
    const limiter = createFixedWindowLimiter({ limit: 2, windowMs: ACCESS_CODE_IP_WINDOW_MS });
    const check = (request: Request) => checkRateLimitPair(request, limiter, neverFullGlobalLimiter(), formatAccessCodeRateLimitMessage);
    const attempt = () => POST(withIp(postJson({ code: REAL_CODE }), "198.51.100.8"), check);

    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(429);
  });

  it("limits each IP separately, so one attacker cannot lock out a real reviewer", async () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: ACCESS_CODE_IP_WINDOW_MS });
    const check = (request: Request) => checkRateLimitPair(request, limiter, neverFullGlobalLimiter(), formatAccessCodeRateLimitMessage);

    expect((await POST(withIp(postJson({ code: "wrong" }), "198.51.100.9"), check)).status).toBe(401);
    expect((await POST(withIp(postJson({ code: "wrong" }), "198.51.100.9"), check)).status).toBe(429);
    // A different address is untouched by the first one's exhausted bucket.
    expect((await POST(withIp(postJson({ code: REAL_CODE }), "198.51.100.10"), check)).status).toBe(200);
  });

  it("checks the limit BEFORE reading the body — an unreadable body from a blocked IP still gets 429", async () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: ACCESS_CODE_IP_WINDOW_MS });
    const check = (request: Request) => checkRateLimitPair(request, limiter, neverFullGlobalLimiter(), formatAccessCodeRateLimitMessage);
    const malformed = () =>
      withIp(
        new Request("http://localhost/api/access-code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not valid json",
        }),
        "198.51.100.11",
      );

    expect((await POST(malformed(), check)).status).toBe(400);
    expect((await POST(malformed(), check)).status).toBe(429);
  });

  it("wires the REAL limiter by default — fails if POST's default binding is dropped", async () => {
    // No limiter injected, so this drives the production singleton. Its
    // own per-IP budget is ACCESS_CODE_IP_LIMIT over 15 minutes, and this
    // IP belongs to this test alone.
    const attempt = () => POST(withIp(postJson({ code: "wrong" }), "198.51.100.200"));
    for (let i = 0; i < ACCESS_CODE_IP_LIMIT; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    expect((await attempt()).status).toBe(429);
  });
});
