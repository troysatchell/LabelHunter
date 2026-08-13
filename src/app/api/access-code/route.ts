/**
 * POST /api/access-code (TRO-482 / LH-061, PRD §8). Checks a submitted
 * code against `ACCESS_CODE` and, on a match, sets the long-lived
 * httpOnly cookie `src/proxy.ts` checks on every later request. This
 * route itself is exempt from the gate (`src/proxy.ts`'s own
 * `EXEMPT_PATHS`) — it is the one endpoint that must be reachable before
 * any credential exists.
 */
import { NextResponse } from "next/server";
import {
  ACCESS_CODE_COOKIE_MAX_AGE_SECONDS,
  ACCESS_CODE_COOKIE_NAME,
  isValidAccessCode,
} from "../../../server/auth/access-code";
import { checkAccessCodeRateLimit, type RateLimitCheckResult } from "../../../server/rate-limit/instances";

const INVALID_CODE_MESSAGE = "That code did not work. Check it and try again.";
const UNREADABLE_BODY_MESSAGE = "LabelHunter could not read that submission. Try again.";

interface AccessCodeErrorResponse {
  error: { message: string };
}

function errorResponse(status: number, message: string): NextResponse<AccessCodeErrorResponse> {
  return NextResponse.json({ error: { message } }, { status });
}

/**
 * Reads the submitted `code` out of an untyped JSON body. Standing rules
 * 13/18: a request body is untrusted input from the boundary — its shape
 * is only assumed, not guaranteed, until checked. Returns `null` for
 * anything that is not exactly a string, rather than coercing — a
 * coerced non-string "code" (e.g. the number `12345` silently becoming
 * `"12345"`) could accidentally validate against a numeric-looking
 * ACCESS_CODE in a way nobody intended.
 */
function readCandidateCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = (body as Record<string, unknown>).code;
  return typeof candidate === "string" ? candidate : null;
}

/** Return type is `NextResponse`, not the bare `Response` most other
 * routes in this repo declare — this route's own tests need `.cookies` to
 * assert the real cookie attributes get set, and `NextResponse` is what
 * this function always actually constructs. */
export async function POST(
  request: Request,
  /**
   * TRO-482, merge review round 1. Injected only so this route's own
   * tests can drive a limiter they control — production always uses the
   * real shared limiter below. Unlike `/api/verify`'s guards, this one is
   * NOT optional-with-an-allow-all-default: a dropped binding here would
   * silently restore unlimited guessing, and this parameter's default IS
   * the real check, so there is nothing to forget to wire.
   */
  checkRateLimit: (request: Request) => RateLimitCheckResult = checkAccessCodeRateLimit,
): Promise<NextResponse> {
  // Checked FIRST, before the body is read and before any comparison.
  // This is the bound that makes guessing the shared code impractical;
  // the constant-time compare in `isValidAccessCode` does nothing against
  // an attacker allowed unlimited attempts.
  const rateLimitResult = checkRateLimit(request);
  if (!rateLimitResult.allowed) {
    return errorResponse(429, rateLimitResult.message);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, UNREADABLE_BODY_MESSAGE);
  }

  const candidate = readCandidateCode(body);

  // Standing rule 18: the submitted code is adversarial, untrusted input —
  // never logged here, on either the accept or the reject path.
  if (!(await isValidAccessCode(candidate))) {
    return errorResponse(401, INVALID_CODE_MESSAGE);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ACCESS_CODE_COOKIE_NAME, candidate as string, {
    httpOnly: true,
    // `false` in local dev (plain http://localhost) — a `Secure` cookie is
    // never sent back over a non-HTTPS connection, which would make local
    // dev silently fail to authenticate. Render terminates the deployed
    // app's traffic over HTTPS, and NODE_ENV is "production" there
    // (Next.js's own convention for `next build && next start`).
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_CODE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
