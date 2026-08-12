/**
 * The shared access-code gate's credential logic (TRO-482 / LH-061, PRD
 * §8, escalation.md rule 7 — security semantics, human read before merge).
 *
 * PRD §8: "shared access code gate (in README for evaluators)." One
 * secret, `ACCESS_CODE`, shared by every evaluator — not a per-user
 * account (PRD §2: "No auth/user accounts"). Two ways to present it,
 * both checked here:
 *   1. A long-lived httpOnly cookie, set by `POST /api/access-code`
 *      (`../../app/api/access-code/route.ts`) after a correct submission
 *      on the `/access-code` page (`../../app/access-code/page.tsx`) — the
 *      browser flow.
 *   2. The `x-access-code` header, for non-browser callers (API-only
 *      testing, evaluator scripts) — PRD §8's own design mandate: "do not
 *      force everything through a browser flow."
 *
 * `src/middleware.ts` calls `hasValidAccessCode` on every request to a
 * protected route/page; this module owns only the credential check, not
 * the redirect/401 decision (middleware's own job).
 *
 * **Untrusted input (standing rule 18).** Both the header and the cookie
 * are adversarial input from outside the trust boundary — validated
 * explicitly here, never assumed to look like a real code. Neither is
 * ever logged: this module has no logging of its own, and the callers
 * below never pass a candidate value to `console.*`.
 *
 * **Constant-time comparison.** `constantTimeEquals` hashes both operands
 * (SHA-256, via Node's built-in `crypto`) before comparing, so the
 * comparison always runs on two fixed-length 32-byte buffers regardless of
 * the candidate's own length — `crypto.timingSafeEqual` itself requires
 * equal-length inputs and throws otherwise, so hashing first is what makes
 * it usable against a candidate of unknown, attacker-controlled length,
 * and it prevents a naive `===`'s character-by-character short-circuit
 * from leaking how many leading characters matched via response timing.
 * A real judgment call for a take-home prototype's stakes, not a
 * mechanical default — worth doing here because it costs a few lines and
 * one already-available Node built-in, no new dependency.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const ACCESS_CODE_COOKIE_NAME = "lh_access_code";
export const ACCESS_CODE_HEADER_NAME = "x-access-code";

/** 30 days — a shared code for a short-lived take-home evaluation window,
 * long enough that an evaluator who authenticates once does not have to
 * re-enter the code on every visit for the life of the review. */
export const ACCESS_CODE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Constant-time string equality — see this file's header comment. */
export function constantTimeEquals(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a, "utf8").digest();
  const hashB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Checks one candidate value against the configured `ACCESS_CODE`. Fails
 * CLOSED: if `ACCESS_CODE` is unset or empty (a misconfigured deployment —
 * the env var was never set, or was set to an accidental empty string),
 * every candidate is rejected, never accepted. The alternative — treating
 * "no code configured" as "the gate is off" — would silently turn a
 * deployment misconfiguration into an open, unprotected public endpoint,
 * exactly the failure mode this whole ticket exists to prevent.
 */
export function isValidAccessCode(candidate: string | null | undefined): boolean {
  const configured = process.env.ACCESS_CODE;
  if (!configured) return false;
  if (!candidate) return false;
  return constantTimeEquals(candidate, configured);
}

/**
 * Reads one named cookie's value out of a raw `Cookie` header string.
 * Minimal, hand-rolled parser rather than a dependency: a `Cookie` header
 * is `name=value; name2=value2`, and this is the one shape this app ever
 * needs to read back.
 */
export function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const rawValue = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      // A malformed percent-encoding in a client-supplied header — standing
      // rule 18: untrusted input, so a decode failure returns "not found"
      // rather than throwing out of a request-handling path.
      return null;
    }
  }
  return null;
}

/**
 * `true` when `request` carries a valid access code, by either credential
 * — the `x-access-code` header OR the `lh_access_code` cookie. Works with
 * a plain `Request` (this file's own tests, and any route handler) and
 * with Next's `NextRequest` (`src/middleware.ts`), since `NextRequest`
 * extends `Request` and this function only reads `.headers`.
 */
export function hasValidAccessCode(request: Request): boolean {
  const headerValue = request.headers.get(ACCESS_CODE_HEADER_NAME);
  if (isValidAccessCode(headerValue)) return true;
  const cookieValue = readCookieValue(request.headers.get("cookie"), ACCESS_CODE_COOKIE_NAME);
  return isValidAccessCode(cookieValue);
}
