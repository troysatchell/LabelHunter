/**
 * An in-memory, fixed-window rate limiter (PRD §8).
 *
 * **In-memory is a scope decision, not an oversight.** The app runs as one
 * Render web service instance, so one process's `Map` is a complete rate
 * limiter. Add a second instance and the real limit silently becomes
 * `limit * instanceCount`. Scaling horizontally means moving this to a
 * shared store — flagged here, not built for a scale this project lacks.
 *
 * A restart resets every counter. A rate limit smooths a burst inside a
 * 60-second window; it holds no durable fact. Losing a minute of counting
 * on a redeploy is a non-event.
 *
 * **Fixed window, not a token bucket.** A fixed window can admit `2 *
 * limit` requests across a boundary — a burst before the reset plus one
 * after. PRD §8 allows either; this is the simpler one.
 *
 * **Bounded key count.** A lazy reset frees a key only when that key is
 * checked again, so a key nobody revisits would live forever. `maxEntries`
 * bounds it with a plain LRU: every `check()` re-inserts its key, so the
 * front of the `Map` is always the least-recently-checked one.
 *
 * **Clock regression.** `now` is injectable, and a test's fake clock can
 * store a window start far in the future. Real time is then behind it, and
 * `at - windowStartMs` goes negative, which a plain `>= windowMs` check
 * never treats as expired. So `check()` also resets when `at` predates the
 * stored start: wall-clock time never runs backward, so the old window has
 * no relationship to the new one.
 */

/** Default cap on distinct keys one limiter tracks at once (TRO-565 finding
 * 3). This deployment is one Render `starter`-plan instance with no
 * horizontal scaling (this file's own header comment above) — a real,
 * scope-appropriate ceiling, not an arbitrary round number: the TTB golden
 * set is ~20-30 labels and a live demo audience is a handful of people
 * (`./instances.ts`'s own reasoning for its rate-limit numbers), so
 * legitimate distinct callers over the life of one process realistically
 * number in the tens, not thousands. 10,000 leaves three orders of
 * magnitude of headroom above that while still bounding worst-case memory
 * to a small, fixed number (each entry is two numbers plus a string key —
 * a few hundred KB at the cap, not a leak) regardless of how long the
 * process runs.
 */
export const DEFAULT_MAX_ENTRIES = 10_000;

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
  /** Hard cap on distinct keys tracked at once (TRO-565 finding 3).
   * Defaults to `DEFAULT_MAX_ENTRIES`. Evicts the least-recently-checked
   * key once exceeded — see this file's own header comment. */
  readonly maxEntries?: number;
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
  if (config.maxEntries !== undefined && (!Number.isInteger(config.maxEntries) || config.maxEntries <= 0)) {
    throw new RangeError(`createFixedWindowLimiter: maxEntries must be a positive integer, got ${config.maxEntries}`);
  }
  const { limit, windowMs } = config;
  const now = config.now ?? Date.now;
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const state = new Map<string, WindowState>();

  /** Marks `key` as the most-recently-used entry by moving it to the end
   * of `state`'s iteration order (delete, then re-insert — `Map` orders by
   * insertion, not by key value). Evicts the single least-recently-used
   * entry first if `key` is new AND the map is already at `maxEntries`. */
  function touch(key: string, value: WindowState): void {
    const isNewKey = !state.has(key);
    if (isNewKey && state.size >= maxEntries) {
      const oldestKey = state.keys().next().value;
      if (oldestKey !== undefined) state.delete(oldestKey);
    }
    state.delete(key);
    state.set(key, value);
  }

  return {
    check(key: string): RateLimitDecision {
      const at = now();
      const existing = state.get(key);

      // TRO-567 finding 3: `at < existing.windowStartMs` means the clock
      // moved backward relative to what this limiter last recorded for
      // this key — real wall-clock time never does that, so treat it the
      // same as an ordinary expired window, not as "still inside a window
      // that started in what now looks like the far future."
      if (!existing || at < existing.windowStartMs || at - existing.windowStartMs >= windowMs) {
        // No window yet, or the previous one has fully elapsed — start a
        // fresh one. Lazy reset (only on the next real check for THIS key),
        // not a timer: a key nobody calls again costs nothing to expire.
        touch(key, { count: 1, windowStartMs: at });
        return { allowed: true, retryAfterMs: 0 };
      }

      existing.count += 1;
      touch(key, existing);
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
