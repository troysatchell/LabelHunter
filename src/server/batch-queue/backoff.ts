/**
 * Failure classification and backoff for the batch queue (LH-041 / TRO-474,
 * CP-3 §5). One policy, in one place: both model clients this ticket calls
 * (`../extractor`, `../resolver`) already set `maxRetries: 0` specifically
 * so an SDK-level retry never stacks underneath this module's own backoff
 * (`../extractor/index.ts`'s `DEFAULT_CLIENT_MAX_RETRIES` comment names
 * this ticket directly).
 *
 * TRO-566: also classifies `BudgetExhaustedError` (`../budget/daily-budget`)
 * — a worker that finds the daily budget exhausted right before its model
 * call reuses this SAME retry/backoff state machine, rather than a second,
 * parallel one. See that class's own doc comment for the full reasoning.
 */
import { APIConnectionError, APIError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { BudgetExhaustedError } from "../budget/daily-budget";

/** CP-3 §5.2, proposed — not measured. `maxAttempts` counts CLAIM episodes,
 * not retries-after-the-first: the claim query itself increments `attempts`
 * on every claim (`claim.ts`), so `maxAttempts = 5` means five total tries. */
export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxAttempts: 5,
};

export type ModelCallErrorClassification =
  | { retryable: true; retryAfterMs: number | null; isRateLimit: boolean; isBudgetExhausted?: boolean }
  | { retryable: false; reason: string };

/**
 * Floor on the retry delay for a budget-exhausted item (TRO-566) — NOT
 * governed by `computeBackoffDelayMs`'s exponential formula, which is
 * sized for a transient API error, not a pool-wide spending gate. Proposed,
 * not measured, matching this file's own "proposed default" conventions
 * elsewhere (`pool.ts`'s `POLL_INTERVAL_MS`/`DEFAULT_POOL_COOLDOWN_MS`):
 * long enough that a whole pool checking the SAME exhausted budget does not
 * hot-loop the database, short enough that spend freed up by an operator
 * raising `DAILY_BUDGET_USD` is noticed within a few minutes.
 */
export const BUDGET_EXHAUSTED_RETRY_DELAY_MS = 60_000;

/** Parses the API's own `retry-after` header (whole seconds, CP-3 §4.2's
 * verified page) into milliseconds. `null` when absent or not a valid
 * non-negative number — never `NaN` leaking into a delay computation. */
function extractRetryAfterMs(headers: Headers | undefined): number | null {
  const raw = headers?.get("retry-after");
  if (raw === null || raw === undefined) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

/**
 * Classifies a thrown error as retryable or not, per CP-3 §5.1's table.
 * Retryable: 429 rate-limit, 5xx/overloaded, and network/timeout
 * connection errors. Everything else — a 4xx deterministic API error, a
 * corrupt-image decode failure, a validation error, an unrecognized
 * exception — is non-retryable: retrying a bug or a bad input indefinitely
 * is worse than failing fast and surfacing it in `last_error` (CP-3 §5.1).
 */
export function classifyModelCallError(error: unknown): ModelCallErrorClassification {
  if (error instanceof BudgetExhaustedError) {
    return { retryable: true, retryAfterMs: BUDGET_EXHAUSTED_RETRY_DELAY_MS, isRateLimit: false, isBudgetExhausted: true };
  }
  if (error instanceof RateLimitError) {
    return { retryable: true, retryAfterMs: extractRetryAfterMs(error.headers), isRateLimit: true };
  }
  if (error instanceof InternalServerError) {
    return { retryable: true, retryAfterMs: extractRetryAfterMs(error.headers), isRateLimit: false };
  }
  // APIConnectionTimeoutError extends APIConnectionError — one check covers both.
  if (error instanceof APIConnectionError) {
    return { retryable: true, retryAfterMs: null, isRateLimit: false };
  }
  if (error instanceof APIError) {
    // 400/401/403/404/409/422 and any other status this SDK maps to a
    // specific class — deterministic; retrying resends the same request.
    return { retryable: false, reason: error.message };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return { retryable: false, reason };
}

/**
 * Exponential backoff with jitter, seeded from the API's own `retry-after`
 * when present (CP-3 §5.2). `attempts` is the item's CURRENT attempt count
 * (already incremented by the claim query, `claim.ts`) — attempt 1's delay
 * is `baseDelayMs`, doubling each attempt after, capped at `maxDelayMs`.
 *
 * `jitterFn` returns a value in `[0, 1)` (default `Math.random`) — the
 * jitter added is `jitterFn() * baseDelayMs`, so two workers hitting the
 * same failure at the same instant do not retry in lockstep.
 */
export function computeBackoffDelayMs(
  attempts: number,
  config: BackoffConfig,
  retryAfterMs: number | null,
  jitterFn: () => number = Math.random,
): number {
  const exponential = Math.min(config.baseDelayMs * 2 ** (attempts - 1), config.maxDelayMs);
  const withJitter = exponential + jitterFn() * config.baseDelayMs;
  return retryAfterMs !== null ? Math.max(withJitter, retryAfterMs) : withJitter;
}

/**
 * The pool-wide cooldown coordinator (CP-3 §5.3): a shared, in-memory
 * "cooldown until" timestamp every worker in ONE pool checks before
 * attempting a new claim. This is an additive coordination refinement on
 * top of `computeBackoffDelayMs`'s per-item delay, not a replacement for
 * it (CP-3 §5.3) — and it assumes a single worker-pool process, the same
 * assumption CP-3 §5.3 states explicitly for the same reason: an in-memory
 * timestamp coordinates threads/async tasks sharing one process's memory,
 * nothing across two separate deployed processes.
 */
export interface PoolCooldownState {
  cooldownUntilMs: number;
}

/** Proposed, not measured — used only when a 429 carries no `retry-after`
 * header (rare, per CP-3 §4.2's verified page, but not impossible). */
export const DEFAULT_POOL_COOLDOWN_MS = 5000;

/** Milliseconds a worker's claim loop should wait before its next claim
 * attempt, given `nowMs`. `0` means no cooldown is in effect. */
export function waitMsForCooldown(cooldown: PoolCooldownState, nowMs: number): number {
  return Math.max(0, cooldown.cooldownUntilMs - nowMs);
}

/**
 * Records that some worker in this pool just saw a 429. Extends the
 * cooldown window — never shrinks an already-later one, so a second 429
 * arriving mid-cooldown cannot cut the first one's window short.
 */
export function noteRateLimited(cooldown: PoolCooldownState, retryAfterMs: number | null, nowMs: number): void {
  const candidate = nowMs + (retryAfterMs ?? DEFAULT_POOL_COOLDOWN_MS);
  cooldown.cooldownUntilMs = Math.max(cooldown.cooldownUntilMs, candidate);
}
