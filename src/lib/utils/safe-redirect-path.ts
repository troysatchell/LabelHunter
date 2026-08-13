/**
 * Confirms a `next` redirect target is safe to send a browser to
 * (TRO-565 finding 1, TH-R6).
 *
 * Two callers share this one function on purpose:
 *   1. `src/proxy.ts` builds `next` from the ORIGINAL request path before an
 *      unauthenticated visitor is redirected to `/access-code?next=...`.
 *   2. `src/app/_components/AccessCodeForm.tsx` reads `next` back out of the
 *      URL after a correct code, and calls `router.push(next)`.
 *
 * An attacker who sends a victim a link like
 * `/access-code?next=https://evil.com` controls caller 2's input directly —
 * `AccessCodeForm.tsx` never asked `proxy.ts` for that value. So caller 2
 * cannot assume `next` is safe just because caller 1 built it from a request
 * path. Both callers sanitize with the SAME function: an open redirect is a
 * single-point failure if only one end checks.
 *
 * The rule: accept only a same-origin, path-relative destination. Reject
 * anything else and fall back to `/`.
 *   - `https://evil.com` — has a scheme. Rejected (does not start with "/").
 *   - `//evil.com` — no scheme, but a browser resolves a leading "//" as
 *     protocol-relative (same scheme, different host). Rejected.
 *   - `/\evil.com` — some URL parsers treat a backslash as a forward slash,
 *     turning this into the same protocol-relative case above. Rejected.
 *   - `/verify?id=3` — a real, path-relative destination. Accepted.
 */
export function sanitizeRedirectPath(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  if (value[0] !== "/") return "/";
  if (value[1] === "/" || value[1] === "\\") return "/";
  return value;
}
