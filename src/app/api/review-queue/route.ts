/**
 * GET /api/review-queue — the review queue's list endpoint (TRO-476, PRD
 * §5, TH-R22, the differentiator: see CHANGES.md).
 *
 * Read-only. Returns one page of unresolved (`disposition IS NULL`) items,
 * oldest first — `src/server/review-queue/list.ts`'s own query, written to
 * use the schema's partial index (`review_queue_unresolved_idx`). It never
 * calls a model (TH-R19: the cascade is the architecture, not this route's
 * job) — it only shapes rows `src/app/api/verify/route.ts` already
 * persisted.
 *
 * **Paging (TRO-507).** `?limit=` sizes the page and `?after=` reads the
 * page that follows a cursor this route issued. The response always
 * carries `nextCursor` — a string while more items follow, `null` at the
 * end of the queue. Before this, the endpoint returned the first 100 items
 * and said nothing about the rest, so a deeper queue looked complete when
 * it was not.
 */
import { NextResponse } from "next/server";
import { db as defaultDb } from "../../../lib/db";
import { decodeReviewQueueCursor, listUnresolvedReviewQueue, MAX_LIST_LIMIT, ReviewQueueCursorError } from "../../../server/review-queue";
import type { ReviewQueueErrorResponse, ReviewQueueListResponse } from "./types";

export interface ReviewQueueListRouteDeps {
  db: typeof defaultDb;
}

const defaultDeps: ReviewQueueListRouteDeps = { db: defaultDb };

function errorResponse(status: number, kind: "VALIDATION" | "SERVICE", message: string): NextResponse<ReviewQueueErrorResponse> {
  return NextResponse.json({ error: { kind, message } }, { status });
}

/** Reads `?limit=`, or `null` when it is absent. Throws `RangeError` on a
 * value this route will not accept — standing rule 13: the query string is
 * a boundary, and "an integer from 1 through MAX_LIST_LIMIT" is the real
 * invariant, not "a number". */
function readLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const limit = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`The limit must be a whole number from 1 through ${MAX_LIST_LIMIT}.`);
  }
  return limit;
}

export async function handleReviewQueueListRequest(request: Request, deps: ReviewQueueListRouteDeps = defaultDeps): Promise<Response> {
  const url = new URL(request.url);

  let limit: number | undefined;
  let after;
  try {
    limit = readLimit(url);
    const rawCursor = url.searchParams.get("after");
    after = rawCursor === null ? undefined : decodeReviewQueueCursor(rawCursor);
  } catch (cause) {
    // A caller's own bad input, not a broken server: say which parameter is
    // wrong so the answer is actionable (TH-R20 — always show the reason).
    const message = cause instanceof RangeError || cause instanceof ReviewQueueCursorError ? cause.message : "The request is not valid.";
    return errorResponse(400, "VALIDATION", message);
  }

  try {
    const page = await listUnresolvedReviewQueue(deps.db, { limit, after });
    const body: ReviewQueueListResponse = {
      items: page.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
      nextCursor: page.nextCursor,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (cause) {
    // Bind and log rather than discard — an operator who sees repeated
    // 503s otherwise has no signal to diagnose (CodeRabbit finding, PR #16
    // review round 2).
    console.error("Could not load the review queue", cause);
    return errorResponse(503, "SERVICE", "LabelHunter could not load the review queue. Try again.");
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleReviewQueueListRequest(request);
}
