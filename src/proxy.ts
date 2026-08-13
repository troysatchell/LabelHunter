/**
 * The shared access-code gate's perimeter enforcement (TRO-482 / LH-061,
 * PRD §8, escalation.md rule 7 — security semantics, human read before
 * merge).
 *
 * Named `proxy.ts`, not `middleware.ts`: this repo is on Next.js 16.3.0,
 * which renamed the file convention (the old name still works but
 * `pnpm build` prints a deprecation warning and names the exact codemod —
 * `npx @next/codemod middleware-to-proxy` — confirmed by actually running
 * it against a throwaway stub during this ticket's own development, not
 * assumed from memory of an older Next version).
 *
 * Runs on every request (see `config.matcher` below) except a short,
 * explicit exemption list — `EXEMPT_PATHS` — and decides one of three
 * outcomes:
 *   1. Exempt path → let it through unconditionally.
 *   2. `../server/auth/access-code.ts`'s `hasValidAccessCode` says yes
 *      (a valid `x-access-code` header, or a valid `lh_access_code`
 *      cookie) → let it through.
 *   3. Otherwise → an API route (`/api/*`) gets a 401 JSON body with a
 *      friendly message; any other path (a page) gets redirected to
 *      `/access-code`, carrying `?next=` so a successful submission can
 *      send the visitor back to where they were headed.
 *
 * **Why `/api/health` is exempt.** `render.yaml`'s `healthCheckPath:
 * /api/health` — Render polls this with no credential at all. Gating it
 * would make Render see the app as permanently unhealthy and cycle the
 * instance forever.
 *
 * **Why `/access-code` and `/api/access-code` are exempt.** The page that
 * collects the code, and the endpoint that checks it and sets the cookie,
 * cannot themselves require the cookie they are the ones handing out —
 * gating them would make it impossible to ever get in.
 */
import { NextResponse, type NextRequest } from "next/server";
import { hasValidAccessCode } from "./server/auth/access-code";
import { sanitizeRedirectPath } from "./lib/utils/safe-redirect-path";

const EXEMPT_PATHS = new Set<string>(["/api/health", "/access-code", "/api/access-code"]);

/** Strips a trailing slash before matching `EXEMPT_PATHS` (TRO-565 finding
 * 4) — `/api/health/` must exempt the same as `/api/health`. Render's own
 * health check always requests the exact path this repo's `render.yaml`
 * names, so this is a defensive normalization, not a response to a
 * measured outage. The root path "/" is left alone: stripping its own
 * trailing slash would turn it into the empty string. */
function withoutTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/** ASD-STE100 / Zinsser copy (CLAUDE.md) — shown to a non-browser caller
 * (an evaluator script, an API test) that omitted the credential. Names
 * both ways to fix it, in plain English. */
const ACCESS_CODE_REQUIRED_API_MESSAGE =
  "This request needs a valid access code. Add it as the x-access-code header, or open this URL in a browser and enter the code first.";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (EXEMPT_PATHS.has(withoutTrailingSlash(pathname))) {
    return NextResponse.next();
  }

  if (await hasValidAccessCode(request)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { kind: "UNAUTHORIZED", message: ACCESS_CODE_REQUIRED_API_MESSAGE } }, { status: 401 });
  }

  const redirectUrl = new URL("/access-code", request.url);
  // TRO-565 finding 1: sanitize the SAME way AccessCodeForm.tsx does before
  // this value is ever put into the query string. `pathname` cannot
  // literally carry a scheme, but it CAN start with "//" (a client can
  // request `GET //evil.com/steal`), which a browser later resolves as
  // protocol-relative — see this ticket's own proxy.test.ts case.
  const next = sanitizeRedirectPath(`${pathname}${request.nextUrl.search}`);
  if (next !== "/") {
    redirectUrl.searchParams.set("next", next);
  }
  return NextResponse.redirect(redirectUrl);
}

export const config = {
  // Next's own documented pattern: run on everything except its own static
  // asset/image-optimizer paths and the favicon — those are never gated,
  // gating them would only add latency with no protection benefit (they
  // carry no application data).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
