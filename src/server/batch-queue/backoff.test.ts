/**
 * Tests for `backoff.ts` (LH-041 / TRO-474, CP-3 §5).
 */
import { APIConnectionError, APIConnectionTimeoutError, BadRequestError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { BudgetExhaustedError } from "../budget/daily-budget";
import {
  BUDGET_EXHAUSTED_RETRY_DELAY_MS,
  classifyModelCallError,
  computeBackoffDelayMs,
  DEFAULT_BACKOFF_CONFIG,
  noteRateLimited,
  waitMsForCooldown,
} from "./backoff";

function rateLimitError(retryAfterSeconds?: string): RateLimitError {
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) headers.set("retry-after", retryAfterSeconds);
  return new RateLimitError(429, { type: "rate_limit_error", message: "rate limited" }, "429 rate_limit_error", headers, "rate_limit_error");
}

function internalServerError(status = 529): InternalServerError {
  const headers = new Headers();
  return new InternalServerError(status, { type: "overloaded_error", message: "overloaded" }, `${status} overloaded_error`, headers, "overloaded_error");
}

function badRequestError(): BadRequestError {
  const headers = new Headers();
  return new BadRequestError(400, { type: "invalid_request_error", message: "bad" }, "400 invalid_request_error", headers, "invalid_request_error");
}

describe("classifyModelCallError", () => {
  it("classifies a 429 rate-limit error as retryable, carrying retry-after in milliseconds", () => {
    const result = classifyModelCallError(rateLimitError("3"));
    expect(result).toEqual({ retryable: true, retryAfterMs: 3000, isRateLimit: true });
  });

  it("classifies a 429 with no retry-after header as retryable with a null delay hint", () => {
    const result = classifyModelCallError(rateLimitError());
    expect(result).toEqual({ retryable: true, retryAfterMs: null, isRateLimit: true });
  });

  it("classifies a 5xx / overloaded error as retryable, not a rate limit", () => {
    const result = classifyModelCallError(internalServerError(529));
    expect(result).toEqual({ retryable: true, retryAfterMs: null, isRateLimit: false });
  });

  it("classifies a network connection error as retryable", () => {
    const result = classifyModelCallError(new APIConnectionError({ message: "Connection error." }));
    expect(result).toEqual({ retryable: true, retryAfterMs: null, isRateLimit: false });
  });

  it("classifies a connection timeout (a subclass of APIConnectionError) as retryable", () => {
    const result = classifyModelCallError(new APIConnectionTimeoutError());
    expect(result).toEqual({ retryable: true, retryAfterMs: null, isRateLimit: false });
  });

  it("classifies a 400 invalid-request error as non-retryable", () => {
    const result = classifyModelCallError(badRequestError());
    expect(result).toEqual({ retryable: false, reason: expect.stringContaining("400") });
  });

  it("classifies an unrecognized error (e.g. a corrupt-image decode failure) as non-retryable by default", () => {
    const result = classifyModelCallError(new Error("VipsJpeg: Corrupt JPEG data"));
    expect(result).toEqual({ retryable: false, reason: "VipsJpeg: Corrupt JPEG data" });
  });

  it("classifies a non-Error thrown value as non-retryable without throwing itself", () => {
    const result = classifyModelCallError("a plain string throw");
    expect(result.retryable).toBe(false);
  });

  it("ignores a non-numeric retry-after header rather than propagating NaN", () => {
    const result = classifyModelCallError(rateLimitError("not-a-number"));
    expect(result).toEqual({ retryable: true, retryAfterMs: null, isRateLimit: true });
  });

  // TRO-566 finding 1 — a worker's own reservation refusal reuses this
  // SAME classification/backoff state machine, distinguished from a real
  // rate limit so pool.ts's whole-pool cooldown can still engage (it
  // checks isRateLimit OR isBudgetExhausted) without the two conditions
  // being confused for one another anywhere downstream.
  it("classifies a BudgetExhaustedError as retryable, NOT a rate limit, with the fixed budget-cooldown floor", () => {
    const result = classifyModelCallError(new BudgetExhaustedError({ spentUsd: 5, budgetUsd: 5 }));
    expect(result).toEqual({ retryable: true, retryAfterMs: BUDGET_EXHAUSTED_RETRY_DELAY_MS, isRateLimit: false, isBudgetExhausted: true });
  });
});

describe("computeBackoffDelayMs", () => {
  it("grows exponentially with attempts: 1x, 2x, 4x, 8x the base delay", () => {
    const config = { ...DEFAULT_BACKOFF_CONFIG, baseDelayMs: 1000, maxDelayMs: 30_000 };
    const noJitter = () => 0;
    expect(computeBackoffDelayMs(1, config, null, noJitter)).toBe(1000);
    expect(computeBackoffDelayMs(2, config, null, noJitter)).toBe(2000);
    expect(computeBackoffDelayMs(3, config, null, noJitter)).toBe(4000);
    expect(computeBackoffDelayMs(4, config, null, noJitter)).toBe(8000);
  });

  it("caps the exponential growth at maxDelayMs", () => {
    const config = { ...DEFAULT_BACKOFF_CONFIG, baseDelayMs: 1000, maxDelayMs: 5000 };
    const noJitter = () => 0;
    expect(computeBackoffDelayMs(10, config, null, noJitter)).toBe(5000);
  });

  it("does NOT re-cap after adding jitter — maxDelayMs bounds only the exponential term, by design (CP-3 §5.2: the scheduled delay is 'not an upper bound on wall-clock time, since jitter... can... push an individual wait higher')", () => {
    const config = { ...DEFAULT_BACKOFF_CONFIG, baseDelayMs: 1000, maxDelayMs: 5000 };
    const fullJitter = () => 1; // jitterFn returns a [0,1) fraction of baseDelayMs
    // attempts high enough that the exponential term alone already hits the
    // 5000ms cap — full jitter then adds another whole baseDelayMs on top,
    // and the result is NOT clamped back down to maxDelayMs afterward.
    expect(computeBackoffDelayMs(10, config, null, fullJitter)).toBe(6000);
  });

  it("adds jitter on top of the exponential delay", () => {
    const config = { ...DEFAULT_BACKOFF_CONFIG, baseDelayMs: 1000, maxDelayMs: 30_000 };
    const fullJitter = () => 1; // jitterFn returns a [0,1) fraction of baseDelayMs
    expect(computeBackoffDelayMs(1, config, null, fullJitter)).toBe(2000); // 1000 + 1*1000
  });

  it("honors retry-after when it exceeds the computed exponential delay", () => {
    const config = { ...DEFAULT_BACKOFF_CONFIG, baseDelayMs: 1000, maxDelayMs: 30_000 };
    const noJitter = () => 0;
    expect(computeBackoffDelayMs(1, config, 15_000, noJitter)).toBe(15_000);
  });

  it("does not let retry-after shrink a delay already larger than it", () => {
    const config = { ...DEFAULT_BACKOFF_CONFIG, baseDelayMs: 1000, maxDelayMs: 30_000 };
    const noJitter = () => 0;
    expect(computeBackoffDelayMs(4, config, 500, noJitter)).toBe(8000);
  });
});

describe("pool-wide cooldown (§5.3)", () => {
  it("waitMsForCooldown is 0 before any rate limit has been seen", () => {
    const cooldown = { cooldownUntilMs: 0 };
    expect(waitMsForCooldown(cooldown, 1_000)).toBe(0);
  });

  it("noteRateLimited sets a cooldown window every worker's claim loop must honor", () => {
    const cooldown = { cooldownUntilMs: 0 };
    noteRateLimited(cooldown, 5_000, 1_000);
    expect(waitMsForCooldown(cooldown, 1_000)).toBe(5_000);
    expect(waitMsForCooldown(cooldown, 4_000)).toBe(2_000);
    expect(waitMsForCooldown(cooldown, 6_000)).toBe(0);
  });

  it("noteRateLimited without a retry-after hint falls back to a default cooldown", () => {
    const cooldown = { cooldownUntilMs: 0 };
    noteRateLimited(cooldown, null, 1_000);
    expect(waitMsForCooldown(cooldown, 1_000)).toBeGreaterThan(0);
  });

  it("a later, larger cooldown extends the window rather than shrinking it", () => {
    const cooldown = { cooldownUntilMs: 0 };
    noteRateLimited(cooldown, 5_000, 1_000); // until 6000
    noteRateLimited(cooldown, 1_000, 2_000); // would end at 3000 — earlier than 6000
    expect(waitMsForCooldown(cooldown, 2_000)).toBe(4_000); // still honors the 6000 end
  });
});
