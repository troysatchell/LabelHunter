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
  it("reads the address from x-forwarded-for when it carries a single hop", () => {
    expect(getClientIp(requestFrom("203.0.113.5"))).toBe("203.0.113.5");
  });

  it("takes the RIGHTMOST hop, not the leftmost, when the header lists proxy hops (TRO-565 finding 2)", () => {
    // A well-formed proxy APPENDS the peer it directly observed; it never
    // rewrites what came before. So the rightmost entry is the one hop
    // this server's own upstream put there — the only one a caller cannot
    // set by hand. Render/most proxies append hops: "client, proxy1,
    // proxy2" — this repo does not independently trust "client" here; see
    // this file's own header comment for the full reasoning and the
    // Render-specific research notes.
    expect(getClientIp(requestFrom("203.0.113.5, 10.0.0.1, 10.0.0.2"))).toBe("10.0.0.2");
  });

  it("trims incidental whitespace around the address", () => {
    expect(getClientIp(requestFrom("10.0.0.1  ,  203.0.113.5  "))).toBe("203.0.113.5");
  });

  it("ignores a trailing empty segment (a header ending in a stray comma)", () => {
    expect(getClientIp(requestFrom("203.0.113.5, 10.0.0.1,"))).toBe("10.0.0.1");
  });

  it("falls back to a stable placeholder when the header is absent — never throws", () => {
    expect(getClientIp(requestFrom(null))).toBe("unknown");
  });
});

describe("getClientIp — a forged leading hop does not change the key (TRO-565 finding 2)", () => {
  it("returns the SAME address no matter what an attacker puts before the trusted hop", () => {
    const trustedHop = "203.0.113.9";
    expect(getClientIp(requestFrom(`1.2.3.4, ${trustedHop}`))).toBe(trustedHop);
    expect(getClientIp(requestFrom(`9.9.9.9, ${trustedHop}`))).toBe(trustedHop);
    expect(getClientIp(requestFrom(`255.255.255.255, ${trustedHop}`))).toBe(trustedHop);
    expect(getClientIp(requestFrom(`not-even-an-ip, ${trustedHop}`))).toBe(trustedHop);
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
    // A global limit of 2, not 100 (TRO-567 finding 4): the ORIGINAL 100
    // left this assertion true whether or not a rejected attempt touched
    // the global counter — three global.check() calls (A's admitted
    // request, A's rejected retry, B's request) can never push a count of
    // 3 over a limit of 100 either way, so the test could not actually
    // catch the bug it was written to catch. 2 is exact: A's admitted
    // request consumes the global budget's SECOND-TO-LAST slot below the
    // limit... see the exact arithmetic in the comments below.
    const { ip, global } = pair(1, 2);
    const requestA = requestFrom("203.0.113.5");
    checkRateLimitPair(requestA, ip, global); // consumes A's IP budget AND 1 of 2 global slots
    checkRateLimitPair(requestA, ip, global); // rejected on IP check — should NOT touch global
    // A different IP should still see the global counter as if A's second,
    // rejected attempt never happened: 1 of 2 global slots used, 1 left.
    // If the rejected attempt above HAD wrongly consumed a global slot,
    // this request would be the third global.check() against a limit of
    // 2, and would be rejected.
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

  it("a rotated, attacker-controlled leading hop does not mint a fresh bucket (TRO-565 finding 2)", () => {
    // The exact exploit finding 2 describes: a caller who can set
    // x-forwarded-for rotates its value, hoping each request lands in a
    // brand-new per-IP bucket. All three requests below share the same
    // trailing (trusted) hop, so a per-IP limit of 1 must admit only the
    // first.
    const { ip, global } = pair(1, 100);
    const trustedHop = "203.0.113.9";
    const first = checkRateLimitPair(requestFrom(`1.2.3.4, ${trustedHop}`), ip, global);
    const second = checkRateLimitPair(requestFrom(`9.9.9.9, ${trustedHop}`), ip, global);
    const third = checkRateLimitPair(requestFrom(`255.255.255.255, ${trustedHop}`), ip, global);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(third.allowed).toBe(false);
  });
});
