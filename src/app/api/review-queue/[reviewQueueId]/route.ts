/**
 * PATCH /api/review-queue/:reviewQueueId — the review queue's action
 * endpoint (TRO-476, PRD §5: "approve/reject records disposition").
 *
 * Records exactly one fact: a human's APPROVED/REJECTED decision, plus
 * when. It does not touch `verifications.verdict` — the PRD line asks for
 * a disposition to be recorded, not a verdict to change, and this route
 * does not invent that mutation (see CHANGES.md's TRO-476 entry, "open
 * question"). It never calls a model (TH-R19).
 *
 * `PATCH`, not `POST`: this route updates one field of an existing
 * resource rather than creating anything, and this ticket is the first to
 * need that verb in this codebase, so there is no existing convention to
 * follow instead.
 */
import { NextResponse } from "next/server";
import { db as defaultDb } from "../../../../lib/db";
import { toReviewDisposition } from "../../../../lib/db/enums";
import { recordDisposition } from "../../../../server/review-queue";
import type {
  RecordDispositionConflictResponse,
  RecordDispositionRequestBody,
  RecordDispositionResponse,
  ReviewQueueErrorResponse,
} from "../types";

export interface RecordDispositionRouteDeps {
  db: typeof defaultDb;
}

const defaultDeps: RecordDispositionRouteDeps = { db: defaultDb };

function errorResponse(status: number, kind: ReviewQueueErrorResponse["error"]["kind"], message: string): NextResponse<ReviewQueueErrorResponse> {
  return NextResponse.json({ error: { kind, message } }, { status });
}

/** True only when `body` is a well-formed `RecordDispositionRequestBody` —
 * `disposition` is a string; the enum check itself happens separately via
 * `toReviewDisposition`, the one boundary check for both an HTTP body and
 * a model's own output (standing rule 13). */
function isRecordDispositionRequestBody(body: unknown): body is RecordDispositionRequestBody {
  return typeof body === "object" && body !== null && typeof (body as { disposition?: unknown }).disposition === "string";
}

export async function handleRecordDispositionRequest(
  request: Request,
  rawId: string,
  deps: RecordDispositionRouteDeps = defaultDeps,
): Promise<Response> {
  // `Number.isInteger` alone does not catch precision loss above
  // `Number.MAX_SAFE_INTEGER` — a long enough digit string can round to a
  // different, smaller integer and silently address the wrong row (same
  // class this session's own verify/[verificationId]/page.tsx fix
  // addressed; CodeRabbit finding, local review round 5).
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return errorResponse(400, "VALIDATION", "LabelHunter could not read this review-queue item's ID.");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "VALIDATION", "LabelHunter could not read this request.");
  }
  if (!isRecordDispositionRequestBody(payload)) {
    return errorResponse(400, "VALIDATION", 'Send a disposition of "APPROVED" or "REJECTED".');
  }

  let disposition: ReturnType<typeof toReviewDisposition>;
  try {
    disposition = toReviewDisposition(payload.disposition);
  } catch {
    return errorResponse(400, "VALIDATION", 'Send a disposition of "APPROVED" or "REJECTED".');
  }

  try {
    const outcome = await recordDisposition(deps.db, id, disposition);

    if (outcome.status === "not-found") {
      return errorResponse(404, "NOT_FOUND", "LabelHunter could not find that review-queue item.");
    }

    if (outcome.status === "already-disposed") {
      const body: RecordDispositionConflictResponse = {
        error: { kind: "CONFLICT", message: "Someone already recorded a decision on this item." },
        disposition: outcome.disposition,
        disposedAt: outcome.disposedAt.toISOString(),
      };
      return NextResponse.json(body, { status: 409 });
    }

    const body: RecordDispositionResponse = {
      id: outcome.id,
      disposition: outcome.disposition,
      disposedAt: outcome.disposedAt.toISOString(),
    };
    return NextResponse.json(body, { status: 200 });
  } catch (cause) {
    // Bind and log rather than discard: `recordDisposition` throws a
    // specific error when a review_queue row violates the disposition/
    // disposedAt consistency invariant, and that message was previously
    // lost, leaving an operator who sees repeated 503s with no signal to
    // diagnose (CodeRabbit finding, PR #16 review round 2).
    console.error("Could not record a review-queue disposition", cause);
    return errorResponse(503, "SERVICE", "LabelHunter could not record this decision. Try again.");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ reviewQueueId: string }> }): Promise<Response> {
  const { reviewQueueId } = await context.params;
  return handleRecordDispositionRequest(request, reviewQueueId);
}
