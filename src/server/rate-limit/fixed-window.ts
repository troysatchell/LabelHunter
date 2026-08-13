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
 *
 * **Bounded key count (TRO-565 finding 3).** The lazy reset above frees a
 * key's MEMORY only the next time that exact key is checked again — a key
 * nobody ever revisits stays in `state` forever. `../../proxy.ts`'s gate
 * sits in front of every route this limiter protects, so an unauthenticated
 * caller cannot reach `/api/verify` or `/api/batch/start` at all; the
 * realistic source of many distinct keys is `/api/access-code` itself
 * (exempt from the gate, by necessity — see `./instances.ts`'s own header
 * comment) plus finding 2's own fix landing: even with `getClientIp` now
 * keying on a hop a caller cannot forge, a long-lived process still accrues
 * one entry per distinct real caller over its lifetime. `maxEntries` (below)
 * bounds that growth with a plain LRU: `state` is a `Map`, whose iteration
 * order tracks INSERTION order; every `check()` call re-inserts its key (via
 * `delete` then `set`), which moves it to the end, so the front of the map
 * is always the least-recently-checked key. Exceeding the cap evicts
 * exactly that one key before admitting the new one.
 *
 * **Clock regression (TRO-567 finding 3).** `now` is injectable — real
 * production code always uses `Date.now`, but a test can fake it. Vitest's
 * `vi.setSystemTime` fakes the WHOLE process clock, including any call this
 * limiter's production singletons (`./instances.ts`) make while a caller
 * elsewhere in the suite has moved the clock far into the future to isolate
 * a date-keyed database row (`../../app/api/verify/route.test.ts`'s own
 * 2099 tests, TRO-482 merge review). That stores a window-start timestamp
 * far in the future. Once the fake clock is torn down, real time is
 * BEHIND that stored timestamp — `at - windowStartMs` is a large NEGATIVE
 * number, which the plain `>= windowMs` check below would never treat as
 * "expired," pinning that key's stale window for the rest of the process.
 * `check()` also resets whenever `at` is earlier than the stored
 * `windowStartMs`: real wall-clock time never runs backward, so a `now()`
 * that goes backward relative to what this limiter last recorded is, by
 * construction, either a test's fake clock unwinding or an actual system
 * clock correction — in both cases the old window has no meaningful
 * relationship to the new `at`, and starting fresh is the only reading that
 * makes sense.
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
