/**
 * Tests for the in-memory fixed-window rate limiter (TRO-482 / LH-061,
 * PRD §8). Written first, per PRD §6's TDD mandate. Every timing-dependent
 * case uses an INJECTED clock (a plain closure returning a mutable
 * counter) — never a real sleep, per standing rule 8.
 */
import { describe, expect, it } from "vitest";
import { createFixedWindowLimiter, formatRateLimitMessage } from "./fixed-window";

/** A controllable clock: `advance(ms)` moves it forward; the limiter reads
 * it through `now()`. No `setTimeout`, no real elapsed time anywhere in
 * this file. */
function fakeClock(startMs = 0) {
  let current = startMs;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

describe("createFixedWindowLimiter", () => {
  it("allows requests up to the limit within one window", () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 60_000, now: clock.now });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("rejects the (limit + 1)th request within the same window", () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 60_000, now: clock.now });
    limiter.check("a");
    limiter.check("a");
    limiter.check("a");
    const fourth = limiter.check("a");
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("reports a retryAfterMs no larger than the window itself", () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 10_000, now: clock.now });
    limiter.check("a");
    const rejected = limiter.check("a");
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(10_000);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows a request again once the window has fully elapsed", () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 10_000, now: clock.now });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    clock.advance(10_001);
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("tracks each key independently — one caller's limit does not affect another's", () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    expect(limiter.check("ip-1").allowed).toBe(true);
    expect(limiter.check("ip-1").allowed).toBe(false);
    // A completely different key still has its own fresh budget.
    expect(limiter.check("ip-2").allowed).toBe(true);
  });

  it("rejects a non-integer or non-positive limit at construction — a boundary value, validated", () => {
    expect(() => createFixedWindowLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => createFixedWindowLimiter({ limit: -1, windowMs: 1000 })).toThrow(RangeError);
    expect(() => createFixedWindowLimiter({ limit: 1.5, windowMs: 1000 })).toThrow(RangeError);
  });

  it("rejects a non-positive windowMs at construction", () => {
    expect(() => createFixedWindowLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
    expect(() => createFixedWindowLimiter({ limit: 1, windowMs: -100 })).toThrow(RangeError);
  });
});

describe("createFixedWindowLimiter — bounded key count (TRO-565 finding 3)", () => {
  it("evicts the least-recently-used key once maxEntries is exceeded, freeing it for a fresh window", () => {
    const clock = fakeClock();
    // A window that never naturally expires within this test (huge windowMs)
    // isolates the eviction behavior from the ordinary expiry path above.
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1_000_000_000, now: clock.now, maxEntries: 2 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    // A third distinct key exceeds maxEntries: 2 — "a" is the oldest entry
    // and must be evicted to make room.
    expect(limiter.check("c").allowed).toBe(true);
    // If "a" were still tracked, this would be its SECOND check inside a
    // still-active window with limit: 1 — rejected. It is allowed here
    // only because eviction freed the key, so this check starts fresh.
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("refreshes a key's recency on every check, not only on insertion — accessing 'a' again protects it from the next eviction", () => {
    // CodeRabbit review (TRO-565 PR): the test above only proves eviction
    // follows INSERTION order (a, then b, then c — "a" happens to be both
    // oldest-inserted and least-recently-used). This test tells those two
    // apart: it re-checks "a" before adding "c", so "a" is no longer the
    // least-recently-used entry even though it was inserted first — "b" is.
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1_000_000_000, now: clock.now, maxEntries: 2 });

    expect(limiter.check("a").allowed).toBe(true); // "a" inserted
    expect(limiter.check("b").allowed).toBe(true); // "b" inserted — insertion order: a, b
    expect(limiter.check("a").allowed).toBe(false); // "a" re-checked (over its own limit) — but this ALSO refreshes "a" to most-recently-used, leaving "b" as the oldest
    expect(limiter.check("c").allowed).toBe(true); // a THIRD key exceeds maxEntries: 2 — evicts "b" (now the least-recently-used), not "a"

    // "a" is still tracked (it was refreshed, not evicted): a second check
    // within its still-active window is rejected, same as before.
    expect(limiter.check("a").allowed).toBe(false);
    // "b" WAS evicted: this check starts a fresh window for it.
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("never evicts a key that is still within maxEntries", () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1_000_000_000, now: clock.now, maxEntries: 2 });
    limiter.check("a");
    limiter.check("b");
    // Neither key has been evicted — both are still within their own
    // single-request budget, so a second check for either is rejected.
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(false);
  });

  it("rejects a non-integer or non-positive maxEntries at construction — a boundary value, validated", () => {
    expect(() => createFixedWindowLimiter({ limit: 1, windowMs: 1000, maxEntries: 0 })).toThrow(RangeError);
    expect(() => createFixedWindowLimiter({ limit: 1, windowMs: 1000, maxEntries: -1 })).toThrow(RangeError);
    expect(() => createFixedWindowLimiter({ limit: 1, windowMs: 1000, maxEntries: 1.5 })).toThrow(RangeError);
  });
});

describe("createFixedWindowLimiter — resists a clock that moves backward relative to a stored window (TRO-567 finding 3)", () => {
  it("starts a fresh window instead of treating a far-past 'at' as still inside a far-future window", () => {
    // Reproduces the real shape of the bug: a DIFFERENT test elsewhere in
    // the suite fakes the system clock forward (route.test.ts's TRO-482
    // budget-wiring tests move `Date.now()` to 2099 to isolate their own
    // rows in a shared, date-keyed table), and while faked, a real request
    // passes through the production rate-limit singletons, storing a
    // window-start far in the future. Once the fake clock is torn down,
    // real time is far BEHIND that stored window-start forever (a fixed
    // window only expires by ADVANCING past windowStartMs + windowMs) —
    // without this fix, that key would never expire again for the life of
    // the process.
    let currentMs = Date.parse("2099-06-01T00:00:00Z");
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => currentMs });
    expect(limiter.check("ip").allowed).toBe(true);

    currentMs = Date.parse("2026-08-13T00:00:00Z"); // the real clock, resumed
    const result = limiter.check("ip");
    expect(result.allowed).toBe(true);
  });
});

describe("formatRateLimitMessage — friendly, not a raw 429", () => {
  it("is plain English and mentions waiting, not an HTTP status code", () => {
    const message = formatRateLimitMessage(5_000);
    expect(message).not.toMatch(/\b429\b/);
    expect(message.toLowerCase()).toMatch(/wait|moment|again/);
  });

  it("states a concrete number of seconds, rounded up so it never underestimates the real wait", () => {
    expect(formatRateLimitMessage(1)).toMatch(/1 second/);
    expect(formatRateLimitMessage(1_500)).toMatch(/2 seconds/);
    expect(formatRateLimitMessage(60_000)).toMatch(/60 seconds/);
  });
});
