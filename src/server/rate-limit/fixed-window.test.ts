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
