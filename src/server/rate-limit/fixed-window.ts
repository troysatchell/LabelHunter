/**
 * An in-memory, fixed-window rate limiter (TRO-482 / LH-061, PRD §8).
 *
 * **In-memory is a deliberate, documented, scope-appropriate choice, not an
 * oversight (TH-R19: appropriate technical choices for the scope, defended
 * in docs).** This app runs as one Render `starter`-plan web service
 * instance (`render.yaml`; PRD §8 names no horizontal scaling for this
 * prototype). A single process's own `Map` is a complete, correct rate
 * limiter for that topology — there is only ever one counter to keep
 * consistent. It stops being correct the moment a second instance joins
 * (each process would keep its own counters, so the REAL combined limit
 * would be `limit * instanceCount`, silently). If this deployment ever
 * scales horizontally, this limiter needs to move to a shared store
 * (Redis, or Postgres like the daily budget guard already does) — flagged
 * here, not built speculatively for a scale this project does not have.
 *
 * A process restart resets every counter to zero — the SAME limitation the
 * daily budget guard (`../budget/daily-budget.ts`) exists specifically to
 * avoid for spend, but is fine here: a rate limit's job is to smooth out a
 * burst within a short window (60s, this file's own production instances),
 * not to hold a durable fact across restarts. Losing a minute of counting
 * on a redeploy is a non-event, not a security gap.
 *
 * **Fixed window, not a token bucket or sliding log.** A fixed window can
 * admit up to `2 * limit` requests across a window BOUNDARY (a burst just
 * before the window resets, plus a fresh burst just after) — a known,
 * accepted imprecision for a prototype's abuse-smoothing goal, not a
 * precise SLA. PRD §8 explicitly allows "a fixed-window or token-bucket
 * counter... is sufficient" — this repo picks the simpler of the two
 * sufficient options.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Milliseconds until the CURRENT window resets. `0` when `allowed` is
   * `true` — there is nothing to wait for. */
  readonly retryAfterMs: number;
}

export interface FixedWindowLimiterConfig {
  /** Max requests admitted per key, per window. */
  readonly limit: number;
  readonly windowMs: number;
  /** Injectable clock — defaults to `Date.now`. Tests pass a fake, fully
   * controllable clock (standing rule 8: never a real sleep in a rate-limit
   * window test). */
  readonly now?: () => number;
}

export interface FixedWindowLimiter {
  /** Records one attempt for `key` at the current time and reports whether
   * it is allowed. Every call counts, including a call that returns
   * `allowed: false` — checking is not free to retry silently. */
  check(key: string): RateLimitDecision;
}

interface WindowState {
  count: number;
  windowStartMs: number;
}

/**
 * Builds one independent fixed-window limiter. Each distinct `key` (an IP
 * address, or a single fixed string for a "global" limiter — see
 * `./instances.ts`) gets its own counter and its own window.
 *
 * Validates its own config at construction (standing rule 13: a boundary
 * value, not assumed correct) — a limiter built with `limit: 0` would
 * silently reject every request forever, which reads as "the service is
 * down," not "rate limited"; failing loudly at startup is far better than
 * that discovered live.
 */
export function createFixedWindowLimiter(config: FixedWindowLimiterConfig): FixedWindowLimiter {
  if (!Number.isInteger(config.limit) || config.limit <= 0) {
    throw new RangeError(`createFixedWindowLimiter: limit must be a positive integer, got ${config.limit}`);
  }
  if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
    throw new RangeError(`createFixedWindowLimiter: windowMs must be a positive number, got ${config.windowMs}`);
  }
  const { limit, windowMs } = config;
  const now = config.now ?? Date.now;
  const state = new Map<string, WindowState>();

  return {
    check(key: string): RateLimitDecision {
      const at = now();
      const existing = state.get(key);

      if (!existing || at - existing.windowStartMs >= windowMs) {
        // No window yet, or the previous one has fully elapsed — start a
        // fresh one. Lazy reset (only on the next real check for THIS key),
        // not a timer: a key nobody calls again costs nothing to expire.
        state.set(key, { count: 1, windowStartMs: at });
        return { allowed: true, retryAfterMs: 0 };
      }

      existing.count += 1;
      if (existing.count > limit) {
        const retryAfterMs = existing.windowStartMs + windowMs - at;
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1) };
      }
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

/** Friendly, ASD-STE100/Zinsser copy (CLAUDE.md) for a rejected request —
 * never a bare 429 with no explanation (this ticket's own acceptance
 * evidence). Rounds UP to whole seconds so the stated wait never
 * understates the real one. */
export function formatRateLimitMessage(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const unit = seconds === 1 ? "second" : "seconds";
  return `LabelHunter is getting more requests than it can handle right now. Wait ${seconds} ${unit} and try again.`;
}
