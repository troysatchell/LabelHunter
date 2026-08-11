/**
 * Client-side fetch wrapper for the review queue screens (TRO-476, TH-R20's
 * designed error states). Pure — no React import — so it is unit tested
 * directly with a fake `fetch`, the same pattern `verify-client.ts` uses.
 */
import { REVIEW_DISPOSITIONS, type ReviewDisposition } from "../../lib/db/enums";
import {
  REVIEW_QUEUE_ERROR_KINDS,
  type RecordDispositionConflictResponse,
  type RecordDispositionResponse,
  type ReviewQueueErrorKind,
  type ReviewQueueErrorResponse,
  type ReviewQueueListItemWire,
  type ReviewQueueListResponse,
} from "../api/review-queue/types";

export class ReviewQueueClientError extends Error {
  readonly kind: ReviewQueueErrorKind;
  /** Set only when `kind === "CONFLICT"` — the disposition that already
   * won, straight from the 409 body, so the caller can show a specific
   * message ("Someone already approved this item") instead of a generic
   * one. */
  readonly conflictDisposition?: ReviewDisposition;

  constructor(kind: ReviewQueueErrorKind, message: string, conflictDisposition?: ReviewDisposition) {
    super(message);
    this.name = "ReviewQueueClientError";
    this.kind = kind;
    this.conflictDisposition = conflictDisposition;
  }
}

export interface ReviewQueueRequestOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function isReviewQueueErrorResponse(payload: unknown): payload is ReviewQueueErrorResponse {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return false;
  const error = (payload as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { kind, message } = error as { kind?: unknown; message?: unknown };
  return typeof kind === "string" && (REVIEW_QUEUE_ERROR_KINDS as readonly string[]).includes(kind) && typeof message === "string";
}

function isReviewQueueListResponse(payload: unknown): payload is ReviewQueueListResponse {
  if (typeof payload !== "object" || payload === null) return false;
  return Array.isArray((payload as Partial<ReviewQueueListResponse>).items);
}

function isRecordDispositionResponse(payload: unknown): payload is RecordDispositionResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Partial<RecordDispositionResponse>;
  return (
    typeof body.id === "number" &&
    typeof body.disposition === "string" &&
    (REVIEW_DISPOSITIONS as readonly string[]).includes(body.disposition) &&
    typeof body.disposedAt === "string"
  );
}

function isRecordDispositionConflictResponse(payload: unknown): payload is RecordDispositionConflictResponse {
  if (!isReviewQueueErrorResponse(payload) || payload.error.kind !== "CONFLICT") return false;
  const body = payload as unknown as Partial<RecordDispositionConflictResponse>;
  return (
    typeof body.disposition === "string" &&
    (REVIEW_DISPOSITIONS as readonly string[]).includes(body.disposition) &&
    typeof body.disposedAt === "string"
  );
}

function defaultFetch(): typeof fetch {
  // `.bind(globalThis)`, not a bare `fetch` reference — see
  // verify-client.ts's identical comment; some engines throw "Illegal
  // invocation" when `fetch` is called detached from its receiver.
  return globalThis.fetch.bind(globalThis);
}

/** Reads every unresolved review-queue item, oldest first (PRD §5). Rejects
 * with `ReviewQueueClientError` on every failure mode TH-R20 names —
 * network failure, a non-2xx response, or a response this client cannot
 * even parse. */
export async function fetchReviewQueue(options: ReviewQueueRequestOptions = {}): Promise<ReviewQueueListItemWire[]> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();

  let response: Response;
  try {
    response = await fetchImpl("/api/review-queue");
  } catch {
    throw new ReviewQueueClientError("SERVICE", "LabelHunter could not reach the server. Check your connection and try again.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ReviewQueueClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }

  if (!response.ok) {
    if (isReviewQueueErrorResponse(payload)) {
      throw new ReviewQueueClientError(payload.error.kind, payload.error.message);
    }
    throw new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again.");
  }

  if (!isReviewQueueListResponse(payload)) {
    throw new ReviewQueueClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }
  return payload.items;
}

/** Records one human decision on one review-queue item (PRD §5:
 * "approve/reject records disposition"). Rejects with
 * `ReviewQueueClientError` on every failure mode, including `"CONFLICT"`
 * when someone else already recorded a decision on this item first. */
export async function submitDisposition(
  reviewQueueId: number,
  disposition: ReviewDisposition,
  options: ReviewQueueRequestOptions = {},
): Promise<RecordDispositionResponse> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();

  let response: Response;
  try {
    response = await fetchImpl(`/api/review-queue/${reviewQueueId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition }),
    });
  } catch {
    throw new ReviewQueueClientError("SERVICE", "LabelHunter could not reach the server. Check your connection and try again.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ReviewQueueClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }

  if (!response.ok) {
    if (isRecordDispositionConflictResponse(payload)) {
      throw new ReviewQueueClientError("CONFLICT", payload.error.message, payload.disposition);
    }
    if (isReviewQueueErrorResponse(payload)) {
      throw new ReviewQueueClientError(payload.error.kind, payload.error.message);
    }
    throw new ReviewQueueClientError("SERVICE", "LabelHunter could not record this decision. Try again.");
  }

  if (!isRecordDispositionResponse(payload)) {
    throw new ReviewQueueClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }
  return payload;
}
