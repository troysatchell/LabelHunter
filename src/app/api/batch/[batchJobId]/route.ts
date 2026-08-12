/**
 * GET /api/batch/:batchJobId — the batch progress polling endpoint (LH-042
 * / TRO-475, PRD §3.5, §5, TH-R4).
 *
 * Read-only. Every poll reads live off `batch_jobs` / `batch_queue_items` /
 * `verifications` via `getBatchProgress`
 * (`../../../../server/batch-progress`) — no separate cached counters of
 * its own. Never calls a model (TH-R19).
 */
import { NextResponse } from "next/server";
import { db as defaultDb } from "../../../../lib/db";
import { getBatchProgress } from "../../../../server/batch-progress";
import type { BatchProgressErrorKind, BatchProgressErrorResponse, BatchProgressResponse } from "./types";

export interface BatchProgressRouteDeps {
  db: typeof defaultDb;
}

const defaultDeps: BatchProgressRouteDeps = { db: defaultDb };

function errorResponse(status: number, kind: BatchProgressErrorKind, message: string): NextResponse<BatchProgressErrorResponse> {
  return NextResponse.json({ error: { kind, message } }, { status });
}

export async function handleBatchProgressRequest(rawId: string, deps: BatchProgressRouteDeps = defaultDeps): Promise<Response> {
  // `Number()` alone accepts hex ("0x10"), exponent notation ("1e2"), signs,
  // and decimals — reject anything that is not already canonical decimal
  // digits before converting, the same boundary check
  // `verify/[verificationId]/page.tsx` and
  // `review-queue/[reviewQueueId]/route.ts` both already use for a URL id.
  if (!/^\d+$/.test(rawId)) {
    return errorResponse(400, "VALIDATION", "LabelHunter could not read this batch's ID.");
  }
  const batchJobId = Number(rawId);
  if (!Number.isSafeInteger(batchJobId) || batchJobId <= 0) {
    return errorResponse(400, "VALIDATION", "LabelHunter could not read this batch's ID.");
  }

  try {
    const result = await getBatchProgress(deps.db, batchJobId);
    if (!result.found) {
      return errorResponse(404, "NOT_FOUND", "LabelHunter could not find that batch.");
    }

    const { progress } = result;
    const body: BatchProgressResponse = {
      batchJobId: progress.batchJobId,
      status: progress.status,
      totalCount: progress.totalCount,
      processedCount: progress.processedCount,
      autoVerifiedCount: progress.autoVerifiedCount,
      passCount: progress.passCount,
      failCount: progress.failCount,
      resolvedBySonnetCount: progress.resolvedBySonnetCount,
      needsHumanCount: progress.needsHumanCount,
      failedCount: progress.failedCount,
      startedAt: progress.startedAt ? progress.startedAt.toISOString() : null,
      completedAt: progress.completedAt ? progress.completedAt.toISOString() : null,
      latency: progress.latency,
      rateLimitBackoff: progress.rateLimitBackoff,
      results: progress.results,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (cause) {
    // Bind and log rather than discard — matching every other route in
    // this codebase (`review-queue/route.ts`'s own identical comment): an
    // operator who sees repeated 503s otherwise has no signal to diagnose.
    console.error("Could not load batch progress", cause);
    return errorResponse(503, "SERVICE", "LabelHunter could not load this batch's progress. Try again.");
  }
}

export async function GET(_request: Request, context: { params: Promise<{ batchJobId: string }> }): Promise<Response> {
  const { batchJobId } = await context.params;
  return handleBatchProgressRequest(batchJobId);
}
