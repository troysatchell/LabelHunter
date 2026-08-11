/**
 * Client-side fetch wrapper for the review queue screens (TRO-476, TH-R20's
 * designed error states). Pure — no React import — so it is unit tested
 * directly with a fake `fetch`, the same pattern `verify-client.ts` uses.
 */
import { BEVERAGE_TYPES, LABEL_VERDICTS, REVIEW_DISPOSITIONS, REVIEW_REASONS, type ReviewDisposition } from "../../lib/db/enums";
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
  /** Hard ceiling on the request, matching TH-R20's "API failure/timeout
   * with a retry affordance" designed error state — same shape as
   * verify-client.ts's `timeoutMs`, sized down: neither request here calls
   * a model, so 15s is generous for a plain DB-backed read or write
   * (CodeRabbit finding, PR #16 review round 2 — without this, a hung
   * connection left the queue in "loading" and the action buttons disabled
   * indefinitely). */
  timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isReviewQueueErrorResponse(payload: unknown): payload is ReviewQueueErrorResponse {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return false;
  const error = (payload as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { kind, message } = error as { kind?: unknown; message?: unknown };
  return typeof kind === "string" && (REVIEW_QUEUE_ERROR_KINDS as readonly string[]).includes(kind) && typeof message === "string";
}

/** True only for the exact canonical form `Date.prototype.toISOString()`
 * produces — which is how every review-queue route on the server side
 * writes these fields (`route.ts`: `.toISOString()`). Merely parseable was
 * not enough: `new Date("2026-08-11")` (no time) parses fine, but it is
 * not the shape this client's own server ever sends, so accepting it would
 * hide real drift instead of catching it. The round-trip through
 * `toISOString()` rejects anything — missing milliseconds, a non-`Z`
 * offset, any other valid-but-non-canonical form — that is not byte-for-
 * byte what the server actually writes (CodeRabbit finding, local review
 * round 3; first version, round 2, only checked "does this parse at all"). */
function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime()) && new Date(value).toISOString() === value;
}

/** Positive integer — the same contract the server's own route validation
 * requires (`route.ts`: `!Number.isInteger(id) || id <= 0` rejects a
 * request). A wire id of 0, negative, or fractional is exactly as
 * malformed here as it would be on the way in (CodeRabbit finding, local
 * review round 2). */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** True only when `item` has every `ReviewQueueListItemWire` field, with an
 * enum field checked against its real closed set — not just "is a
 * string". A malformed item (a schema drift between server and client, a
 * proxy, a future API version) must never reach `ReviewQueueList.tsx` as
 * if it were a real item; standing rule 13 applies at this boundary the
 * same as at any other. */
function isReviewQueueListItemWire(item: unknown): item is ReviewQueueListItemWire {
  if (typeof item !== "object" || item === null) return false;
  const row = item as Partial<ReviewQueueListItemWire>;
  return (
    isPositiveInteger(row.id) &&
    isPositiveInteger(row.verificationId) &&
    isPositiveInteger(row.applicationId) &&
    typeof row.reason === "string" &&
    (REVIEW_REASONS as readonly string[]).includes(row.reason) &&
    typeof row.reasonText === "string" &&
    typeof row.brandName === "string" &&
    typeof row.classType === "string" &&
    typeof row.beverageType === "string" &&
    (BEVERAGE_TYPES as readonly string[]).includes(row.beverageType) &&
    typeof row.labelVerdict === "string" &&
    (LABEL_VERDICTS as readonly string[]).includes(row.labelVerdict) &&
    isCanonicalTimestamp(row.createdAt)
  );
}

function isReviewQueueListResponse(payload: unknown): payload is ReviewQueueListResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const items = (payload as Partial<ReviewQueueListResponse>).items;
  return Array.isArray(items) && items.every(isReviewQueueListItemWire);
}

function isRecordDispositionResponse(payload: unknown): payload is RecordDispositionResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Partial<RecordDispositionResponse>;
  return (
    isPositiveInteger(body.id) &&
    typeof body.disposition === "string" &&
    (REVIEW_DISPOSITIONS as readonly string[]).includes(body.disposition) &&
    isCanonicalTimestamp(body.disposedAt)
  );
}

function isRecordDispositionConflictResponse(payload: unknown): payload is RecordDispositionConflictResponse {
  if (!isReviewQueueErrorResponse(payload) || payload.error.kind !== "CONFLICT") return false;
  const body = payload as unknown as Partial<RecordDispositionConflictResponse>;
  return (
    typeof body.disposition === "string" &&
    (REVIEW_DISPOSITIONS as readonly string[]).includes(body.disposition) &&
    isCanonicalTimestamp(body.disposedAt)
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl("/api/review-queue", { signal: controller.signal });
  } catch {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      throw new ReviewQueueClientError("SERVICE", "LabelHunter took too long to respond. Check your connection and try again.");
    }
    throw new ReviewQueueClientError("SERVICE", "LabelHunter could not reach the server. Check your connection and try again.");
  }

  // The timer stays live through the body read, not just the fetch: a
  // response whose body never finishes streaming would otherwise hang
  // forever once the timeout is cleared here (CodeRabbit finding, local
  // review round 2).
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (controller.signal.aborted) {
      throw new ReviewQueueClientError("SERVICE", "LabelHunter took too long to respond. Check your connection and try again.");
    }
    throw new ReviewQueueClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  } finally {
    clearTimeout(timeoutId);
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`/api/review-queue/${reviewQueueId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      throw new ReviewQueueClientError("SERVICE", "LabelHunter took too long to respond. Check your connection and try again.");
    }
    throw new ReviewQueueClientError("SERVICE", "LabelHunter could not reach the server. Check your connection and try again.");
  }

  // The timer stays live through the body read — see fetchReviewQueue's
  // identical comment (CodeRabbit finding, local review round 2).
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (controller.signal.aborted) {
      throw new ReviewQueueClientError("SERVICE", "LabelHunter took too long to respond. Check your connection and try again.");
    }
    throw new ReviewQueueClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  } finally {
    clearTimeout(timeoutId);
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

  // The shape check alone does not confirm this response is even about the
  // item just requested — a proxy, a cache, or a server bug could return a
  // well-formed RecordDispositionResponse for a different id. Require the
  // response's own id to match what was asked for (CodeRabbit finding,
  // local review round 5).
  if (!isRecordDispositionResponse(payload) || payload.id !== reviewQueueId) {
    throw new ReviewQueueClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }
  return payload;
}
