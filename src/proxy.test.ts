/**
 * Tests for the access-code gate's perimeter enforcement (TRO-482 /
 * LH-061, PRD §8, escalation.md rule 7). Calls `proxy()` directly with a
 * constructed `NextRequest` — no real server boot needed; this is the same
 * "call the handler directly" convention `src/app/api/verify/route.test.ts`
 * already uses for route handlers, applied to the one function Next's own
 * request pipeline calls before any route handler runs.
 *
 * Uses `getRedirectUrl` from `next/experimental/testing/server` (Next's
 * own official testing utility for reading a redirect target out of a
 * `NextResponse`) rather than reaching into response internals by hand.
 */
import { NextRequest } from "next/server";
import { getRedirectUrl } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_CODE_COOKIE_NAME, ACCESS_CODE_HEADER_NAME } from "./server/auth/access-code";
import { proxy } from "./proxy";

const ORIGINAL_ACCESS_CODE = process.env.ACCESS_CODE;
const REAL_CODE = "correct-horse-battery-staple";

beforeEach(() => {
  process.env.ACCESS_CODE = REAL_CODE;
});
afterEach(() => {
  if (ORIGINAL_ACCESS_CODE === undefined) delete process.env.ACCESS_CODE;
  else process.env.ACCESS_CODE = ORIGINAL_ACCESS_CODE;
});

function requestTo(path: string, opts: { header?: string; cookie?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.header !== undefined) headers.set(ACCESS_CODE_HEADER_NAME, opts.header);
  if (opts.cookie !== undefined) headers.set("cookie", `${ACCESS_CODE_COOKIE_NAME}=${opts.cookie}`);
  return new NextRequest(new URL(path, "http://localhost"), { headers });
}

/** `NextResponse.next()` sets this header — Next's own implementation
 * (`node_modules/next/dist/server/web/spec-extension/response.js`),
 * confirmed by reading it directly rather than assumed. */
function letsRequestThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

describe("proxy — exempt paths always pass through, even with no credential", () => {
  it("lets /api/health through unauthenticated — Render's own health check carries no credential", async () => {
    const response = await proxy(requestTo("/api/health"));
    expect(letsRequestThrough(response)).toBe(true);
  });

  it("lets /access-code through unauthenticated — the page that collects the code cannot itself require it", async () => {
    const response = await proxy(requestTo("/access-code"));
    expect(letsRequestThrough(response)).toBe(true);
  });

  it("lets /api/access-code through unauthenticated — the endpoint that hands out the cookie", async () => {
    const response = await proxy(requestTo("/api/access-code"));
    expect(letsRequestThrough(response)).toBe(true);
  });
});

describe("proxy — protected API routes", () => {
  it("rejects an unauthenticated request with a 401 and a friendly JSON body, never a bare status", async () => {
    const response = await proxy(requestTo("/api/verify"));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe("UNAUTHORIZED");
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(body.error.message).not.toMatch(/^error$/i);
  });

  it("lets an authenticated request through via the x-access-code header", async () => {
    const response = await proxy(requestTo("/api/verify", { header: REAL_CODE }));
    expect(letsRequestThrough(response)).toBe(true);
  });

  it("lets an authenticated request through via the cookie", async () => {
    const response = await proxy(requestTo("/api/verify", { cookie: REAL_CODE }));
    expect(letsRequestThrough(response)).toBe(true);
  });

  it("rejects a wrong header value", async () => {
    const response = await proxy(requestTo("/api/verify", { header: "wrong-code" }));
    expect(response.status).toBe(401);
  });

  it("protects batch submission too — /api/batch/start", async () => {
    const response = await proxy(requestTo("/api/batch/start"));
    expect(response.status).toBe(401);
  });
});

describe("proxy — protected pages", () => {
  it("redirects an unauthenticated page visit to /access-code, remembering where it was headed", async () => {
    const response = await proxy(requestTo("/verify"));
    const redirect = getRedirectUrl(response);
    expect(redirect).not.toBeNull();
    const url = new URL(redirect as string);
    expect(url.pathname).toBe("/access-code");
    expect(url.searchParams.get("next")).toBe("/verify");
  });

  it("redirects the home page without a redundant next=/ param", async () => {
    const response = await proxy(requestTo("/"));
    const redirect = getRedirectUrl(response);
    const url = new URL(redirect as string);
    expect(url.pathname).toBe("/access-code");
    expect(url.searchParams.has("next")).toBe(false);
  });

  it("lets an authenticated page visit through via the cookie", async () => {
    const response = await proxy(requestTo("/verify", { cookie: REAL_CODE }));
    expect(letsRequestThrough(response)).toBe(true);
  });
});

describe("proxy — fails closed when ACCESS_CODE itself is not configured", () => {
  it("rejects even a candidate that matches nothing, because nothing can match", async () => {
    delete process.env.ACCESS_CODE;
    const response = await proxy(requestTo("/api/verify", { header: "anything" }));
    expect(response.status).toBe(401);
  });
});
