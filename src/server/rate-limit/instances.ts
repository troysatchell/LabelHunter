/**
 * Production rate-limit instances and numbers for LabelHunter's two
 * expensive routes (TRO-482 / LH-061, PRD §8): `/api/verify` and
 * `/api/batch/start` ("batch submission" — PRD §8's own phrase). Each
 * route gets a per-IP limiter AND a global limiter; both must pass.
 *
 * **The numbers, and the reasoning behind each one.** PRD §4: Haiku
 * extraction ~$0.005/label; Sonnet resolution ~$0.02 on an estimated
 * 10-15% of labels — roughly $0.0075/label blended (see
 * `../budget/daily-budget.ts`'s own header comment for the full
 * derivation). These limits are sized around real evaluator behavior, not
 * a guess: the golden set is ~20-30 labels (PRD §6); a human clicking
 * "Verify" by hand rarely exceeds one submission every few seconds.
 *
 * | Limiter | Limit | Window | Reasoning |
 * |---|---|---|---|
 * | verify, per-IP | 20 | 60s | Generous for a live demo (~1 label every 3s), tight enough to bound a scripted loop from one caller to a small, predictable cost. |
 * | verify, global | 100 | 60s | Comfortably covers several evaluators exploring at once; still caps the whole deployment's worst-case Haiku call rate regardless of how many distinct IPs are involved. |
 * | batch-start, per-IP | 5 | 60s | A batch submission can carry hundreds of images (PRD §3.5) — no legitimate user starts more than a handful of batches per minute. |
 * | batch-start, global | 20 | 60s | Same reasoning as verify's global limit, sized down to match batch-start's own much lower legitimate per-IP rate. |
 *
 * Those four windows are 60s for one reason: PRD §8 names "per-IP +
 * global rate limits" without a specific number, and a single, consistent
 * window length keeps the friendly "wait N seconds" message meaningful
 * across every rejection a user might see, rather than requiring them to
 * remember which route uses which window.
 *
 * **`/api/access-code` is limited too, on different reasoning** (TRO-482,
 * merge review round 1). That endpoint protects no model call, so it
 * costs nothing to run. It is limited because it is the one endpoint
 * `../../proxy.ts` exempts from the gate, so anyone can reach it without
 * a credential — which is exactly what makes it the place to guess the
 * shared code. `../auth/access-code.ts` compares in constant time, and
 * that buys nothing at all against an attacker who may simply keep
 * guessing. This limiter is what makes guessing impractical.
 *
 * | Limiter | Limit | Window | Reasoning |
 * |---|---|---|---|
 * | access-code, per-IP | 10 | 15 min | A person who knows the code needs one attempt. A person fumbling it needs two or three. Ten leaves room for that, and for a few colleagues behind one office IP, while capping one address at 960 guesses a day. |
 * | access-code, global | 100 | 15 min | Bounds the whole deployment to ~9,600 guesses a day across every IP at once, so renting a pool of addresses does not turn into an unlimited attack. Still far above any real day of TTB reviewers signing in. |
 *
 * The window is 15 minutes, not 60 seconds, on purpose. A 60s window
 * resets 1,440 times a day, which would let one address make 14,400
 * guesses. The longer window is what turns the per-IP number into a real
 * daily ceiling.
 */
import { createFixedWindowLimiter, formatRateLimitMessage, type FixedWindowLimiter } from "./fixed-window";

export const VERIFY_IP_LIMIT = 20;
export const VERIFY_IP_WINDOW_MS = 60_000;
export const VERIFY_GLOBAL_LIMIT = 100;
export const VERIFY_GLOBAL_WINDOW_MS = 60_000;

export const BATCH_START_IP_LIMIT = 5;
export const BATCH_START_IP_WINDOW_MS = 60_000;
export const BATCH_START_GLOBAL_LIMIT = 20;
export const BATCH_START_GLOBAL_WINDOW_MS = 60_000;

export const ACCESS_CODE_IP_LIMIT = 10;
export const ACCESS_CODE_IP_WINDOW_MS = 15 * 60_000;
export const ACCESS_CODE_GLOBAL_LIMIT = 100;
export const ACCESS_CODE_GLOBAL_WINDOW_MS = 15 * 60_000;

/** The one key every caller shares for a "global" limiter — any fixed,
 * non-empty string works; it is never compared against a real IP. */
const GLOBAL_KEY = "__global__";

/**
 * The client's own IP address, from `x-forwarded-for` — the header Render
 * (and every common reverse proxy) sets to `client, proxy1, proxy2, ...`.
 * Takes the FIRST entry (the original client), trims incidental
 * whitespace. Falls back to a fixed placeholder, never throws, when the
 * header is absent (local dev with no proxy in front of it) — every caller
 * with no header shares one bucket, a safe degraded behavior rather than
 * silently exempting them from the limit altogether.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export interface RateLimitCheckResult {
  readonly allowed: boolean;
  /** Empty string when `allowed` is `true` — nothing to show. */
  readonly message: string;
}

/**
 * Checks the per-IP limiter first, the global limiter second — and ONLY
 * consumes the global limiter's budget when the per-IP check already
 * passed. This order matters: without it, one IP that has already used up
 * its own per-IP budget and keeps retrying would also keep burning through
 * the SHARED global budget on every rejected attempt, degrading service
 * for every other caller. Checking IP-first means a single abusive caller
 * can only ever exhaust its own bucket.
 */
export function checkRateLimitPair(
  request: Request,
  ipLimiter: FixedWindowLimiter,
  globalLimiter: FixedWindowLimiter,
  /** Builds the message a rejected caller sees. Defaults to the "too busy"
   * wording every model-backed route uses. `/api/access-code` passes its
   * own, because "we are busy" is the wrong and misleading thing to tell
   * someone whose sign-in attempts were the reason. */
  formatMessage: (retryAfterMs: number) => string = formatRateLimitMessage,
): RateLimitCheckResult {
  const ip = getClientIp(request);
  const ipDecision = ipLimiter.check(ip);
  if (!ipDecision.allowed) {
    return { allowed: false, message: formatMessage(ipDecision.retryAfterMs) };
  }
  const globalDecision = globalLimiter.check(GLOBAL_KEY);
  if (!globalDecision.allowed) {
    return { allowed: false, message: formatMessage(globalDecision.retryAfterMs) };
  }
  return { allowed: true, message: "" };
}

/**
 * The message a rejected access-code attempt gets. ASD-STE100 / Zinsser
 * (CLAUDE.md): short sentences, active voice, one instruction.
 *
 * Minutes, not the generic formatter's seconds — this window is 15
 * minutes, and "wait 900 seconds" makes a reader do arithmetic to learn
 * something the sentence could simply have told them.
 *
 * It says the attempt limit was reached. It does not say whether the last
 * code was right or wrong, and it never echoes the submitted value.
 */
export function formatAccessCodeRateLimitMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  const unit = minutes === 1 ? "minute" : "minutes";
  return `Too many access code attempts. Wait ${minutes} ${unit} and try again.`;
}

// One singleton pair per route, for this process's whole lifetime — see
// this file's header comment on why in-memory, per-process state is the
// right, documented choice for this deployment's topology.
const verifyIpLimiter = createFixedWindowLimiter({ limit: VERIFY_IP_LIMIT, windowMs: VERIFY_IP_WINDOW_MS });
const verifyGlobalLimiter = createFixedWindowLimiter({ limit: VERIFY_GLOBAL_LIMIT, windowMs: VERIFY_GLOBAL_WINDOW_MS });
const batchStartIpLimiter = createFixedWindowLimiter({ limit: BATCH_START_IP_LIMIT, windowMs: BATCH_START_IP_WINDOW_MS });
const batchStartGlobalLimiter = createFixedWindowLimiter({ limit: BATCH_START_GLOBAL_LIMIT, windowMs: BATCH_START_GLOBAL_WINDOW_MS });
const accessCodeIpLimiter = createFixedWindowLimiter({ limit: ACCESS_CODE_IP_LIMIT, windowMs: ACCESS_CODE_IP_WINDOW_MS });
const accessCodeGlobalLimiter = createFixedWindowLimiter({ limit: ACCESS_CODE_GLOBAL_LIMIT, windowMs: ACCESS_CODE_GLOBAL_WINDOW_MS });

/** Production rate-limit check for `POST /api/verify`. */
export function checkVerifyRateLimit(request: Request): RateLimitCheckResult {
  return checkRateLimitPair(request, verifyIpLimiter, verifyGlobalLimiter);
}

/**
 * Production rate-limit check for `POST /api/access-code` (TRO-482, merge
 * review round 1). This is the brute-force bound on the shared code — see
 * this file's header comment for the numbers and why they were chosen.
 * Counts every attempt, correct or not: a limiter that only counted
 * failures would let an attacker who has already guessed the code keep
 * going, and counting successes costs a legitimate user nothing, because
 * one success ends their attempts.
 */
export function checkAccessCodeRateLimit(request: Request): RateLimitCheckResult {
  return checkRateLimitPair(request, accessCodeIpLimiter, accessCodeGlobalLimiter, formatAccessCodeRateLimitMessage);
}

/** Production rate-limit check for `POST /api/batch/start`. */
export function checkBatchStartRateLimit(request: Request): RateLimitCheckResult {
  return checkRateLimitPair(request, batchStartIpLimiter, batchStartGlobalLimiter);
}
