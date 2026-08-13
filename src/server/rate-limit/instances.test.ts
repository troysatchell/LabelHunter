/**
 * Tests for `instances.ts` (TRO-482 / LH-061) — IP extraction and the
 * combined per-IP + global check. Written first, per PRD §6's TDD mandate.
 *
 * `checkRateLimitPair` is tested against FRESH `createFixedWindowLimiter`
 * instances built per test, not the module's own production singletons —
 * those singletons are shared, longer-lived state that would make one
 * test's calls bleed into another's (the same reason `../fixed-window.ts`'s
 * own tests never touch a module-level limiter either).
 */
import { describe, expect, it } from "vitest";
import { createFixedWindowLimiter } from "./fixed-window";
import { checkRateLimitPair, getClientIp } from "./instances";

function requestFrom(ip: string | null): Request {
  const headers = new Headers();
  if (ip !== null) headers.set("x-forwarded-for", ip);
  return new Request("http://localhost/api/verify", { headers });
}

describe("getClientIp", () => {
  it("reads the first address from x-forwarded-for", () => {
    expect(getClientIp(requestFrom("203.0.113.5"))).toBe("203.0.113.5");
  });

  it("takes only the client's own address when the header lists proxy hops", () => {
    // Render/most proxies append hops: "client, proxy1, proxy2".
    expect(getClientIp(requestFrom("203.0.113.5, 10.0.0.1, 10.0.0.2"))).toBe("203.0.113.5");
  });

  it("trims incidental whitespace around the address", () => {
    expect(getClientIp(requestFrom("  203.0.113.5  , 10.0.0.1"))).toBe("203.0.113.5");
  });

  it("falls back to a stable placeholder when the header is absent — never throws", () => {
    expect(getClientIp(requestFrom(null))).toBe("unknown");
  });
});

describe("checkRateLimitPair", () => {
  function pair(ipLimit: number, globalLimit: number) {
    return {
      ip: createFixedWindowLimiter({ limit: ipLimit, windowMs: 60_000 }),
      global: createFixedWindowLimiter({ limit: globalLimit, windowMs: 60_000 }),
    };
  }

  it("allows a request under both the per-IP and the global limit", () => {
    const { ip, global } = pair(5, 100);
    const result = checkRateLimitPair(requestFrom("203.0.113.5"), ip, global);
    expect(result.allowed).toBe(true);
  });

  it("rejects once the per-IP limit is exceeded, with a friendly message", () => {
    const { ip, global } = pair(1, 100);
    const request = requestFrom("203.0.113.5");
    checkRateLimitPair(request, ip, global);
    const second = checkRateLimitPair(request, ip, global);
    expect(second.allowed).toBe(false);
    expect(second.message.toLowerCase()).toMatch(/wait|moment|again/);
    expect(second.message).not.toMatch(/\b429\b/);
  });

  it("does not let one IP's rejection consume the shared global budget", () => {
    const { ip, global } = pair(1, 100);
    const requestA = requestFrom("203.0.113.5");
    checkRateLimitPair(requestA, ip, global); // consumes A's IP budget
    checkRateLimitPair(requestA, ip, global); // rejected on IP check — should NOT touch global
    // A different IP should still see the global counter as if A's second,
    // rejected attempt never happened.
    const requestB = requestFrom("198.51.100.9");
    const resultB = checkRateLimitPair(requestB, ip, global);
    expect(resultB.allowed).toBe(true);
  });

  it("rejects once the global limit is exceeded even though each IP is individually under its own limit", () => {
    const { ip, global } = pair(100, 2);
    checkRateLimitPair(requestFrom("203.0.113.1"), ip, global);
    checkRateLimitPair(requestFrom("203.0.113.2"), ip, global);
    const third = checkRateLimitPair(requestFrom("203.0.113.3"), ip, global);
    expect(third.allowed).toBe(false);
  });

  it("tracks two different IPs independently under the per-IP limit", () => {
    const { ip, global } = pair(1, 100);
    expect(checkRateLimitPair(requestFrom("203.0.113.1"), ip, global).allowed).toBe(true);
    expect(checkRateLimitPair(requestFrom("203.0.113.2"), ip, global).allowed).toBe(true);
  });
});
