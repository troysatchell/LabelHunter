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
 * `src/proxy.ts` calls `hasValidAccessCode` on every request to a
 * protected route/page. This module owns only the credential check. It
 * does not decide the redirect or the 401 — that is `src/proxy.ts`'s job.
 *
 * **Untrusted input (standing rule 18).** Both the header and the cookie
 * are adversarial input from outside the trust boundary — validated
 * explicitly here, never assumed to look like a real code. Neither is
 * ever logged: this module has no logging of its own, and the callers
 * below never pass a candidate value to `console.*`.
 *
 * **Constant-time comparison, and why it is async.** `constantTimeEquals`
 * hashes both operands (SHA-256) before comparing, so the comparison
 * always runs over two fixed-length 32-byte digests regardless of the
 * candidate's own (attacker-controlled) length, and it prevents a naive
 * `===`'s character-by-character short-circuit from leaking how many
 * leading characters matched via response timing. `src/proxy.ts`
 * (formerly `middleware.ts` — TRO-482 built this after Next 16's rename;
 * `npx @next/codemod middleware-to-proxy` confirmed the new convention)
 * runs in Next's Edge Runtime, which does NOT support `node:crypto`
 * (confirmed empirically: `pnpm build` throws "A Node.js module is loaded
 * ('node:crypto')... which is not supported in the Edge Runtime" the
 * first time this file imported it). The Web Crypto API
 * (`crypto.subtle`), a global in both the Edge Runtime and Node.js 20+,
 * works in both places — the cost is that `SubtleCrypto.digest` is
 * Promise-based, so every function in this file that hashes is async too.
 */

export const ACCESS_CODE_COOKIE_NAME = "lh_access_code";
export const ACCESS_CODE_HEADER_NAME = "x-access-code";

/** 30 days — a shared code for a short-lived take-home evaluation window,
 * long enough that an evaluator who authenticates once does not have to
 * re-enter the code on every visit for the life of the review. */
export const ACCESS_CODE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

async function sha256(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/**
 * Constant-time string equality — see this file's header comment. Hashes
 * both operands to a fixed 32-byte digest first (`sha256`), then compares
 * every byte unconditionally (XOR-accumulate, never short-circuiting on
 * the first mismatch) — the standard hash-then-compare pattern for
 * secrets of unknown/attacker-controlled length under the Web Crypto API,
 * which has no `timingSafeEqual` primitive of its own.
 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
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
export async function isValidAccessCode(candidate: string | null | undefined): Promise<boolean> {
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
 * with Next's `NextRequest` (`src/proxy.ts`), since `NextRequest` extends
 * `Request` and this function only reads `.headers`.
 */
export async function hasValidAccessCode(request: Request): Promise<boolean> {
  const headerValue = request.headers.get(ACCESS_CODE_HEADER_NAME);
  if (await isValidAccessCode(headerValue)) return true;
  const cookieValue = readCookieValue(request.headers.get("cookie"), ACCESS_CODE_COOKIE_NAME);
  return isValidAccessCode(cookieValue);
}
