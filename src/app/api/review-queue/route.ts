/**
 * GET /api/review-queue — the review queue's list endpoint (TRO-476, PRD
 * §5, TH-R22, the differentiator: see CHANGES.md).
 *
 * Read-only. Returns every unresolved (`disposition IS NULL`) item, oldest
 * first — `src/server/review-queue/list.ts`'s own query, written to use
 * the schema's partial index (`review_queue_unresolved_idx`). It never
 * calls a model (TH-R19: the cascade is the architecture, not this route's
 * job) — it only shapes rows `src/app/api/verify/route.ts` already
 * persisted.
 */
import { NextResponse } from "next/server";
import { db as defaultDb } from "../../../lib/db";
import { listUnresolvedReviewQueue } from "../../../server/review-queue";
import type { ReviewQueueErrorResponse, ReviewQueueListResponse } from "./types";

export interface ReviewQueueListRouteDeps {
  db: typeof defaultDb;
}

const defaultDeps: ReviewQueueListRouteDeps = { db: defaultDb };

function errorResponse(status: number, message: string): NextResponse<ReviewQueueErrorResponse> {
  return NextResponse.json({ error: { kind: "SERVICE", message } }, { status });
}

export async function handleReviewQueueListRequest(deps: ReviewQueueListRouteDeps = defaultDeps): Promise<Response> {
  try {
    const items = await listUnresolvedReviewQueue(deps.db);
    const body: ReviewQueueListResponse = {
      items: items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    };
    return NextResponse.json(body, { status: 200 });
  } catch {
    return errorResponse(503, "LabelHunter could not load the review queue. Try again.");
  }
}

export async function GET(): Promise<Response> {
  return handleReviewQueueListRequest();
}
