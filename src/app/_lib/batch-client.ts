/**
 * Client-side fetch wrappers for the batch upload/progress screens (LH-042
 * / TRO-475, TH-R20's designed error states). Pure — no React import — the
 * same pattern `verify-client.ts`/`review-queue-client.ts` use: an
 * `AbortController` timeout that stays live through the whole response body
 * read, a runtime-validated response shape, and one error class every
 * caller catches.
 */
import { BATCH_JOB_STATUSES } from "../../lib/db/enums";
import { type BatchProgressErrorResponse, type BatchProgressResponse } from "../api/batch/[batchJobId]/types";
import { BATCH_PREVIEW_ERROR_KINDS, type BatchPreviewErrorResponse, type BatchPreviewSuccessResponse } from "../api/batch/preview/types";
import { BATCH_START_ERROR_KINDS, type BatchStartErrorResponse, type BatchStartSuccessResponse } from "../api/batch/start/types";

// RATE_LIMITED and BUDGET_EXHAUSTED (PRD §8's key-protection guard) were
// missing from this union even though the server can send either — every
// call site below already threw them via an unchecked cast. Named here
// instead of cast around.
export type BatchClientErrorKind =
  | "VALIDATION"
  | "MALFORMED_CSV"
  | "MALFORMED_ZIP"
  | "NO_READY_ROWS"
  | "NOT_FOUND"
  | "SERVICE"
  | "RATE_LIMITED"
  | "BUDGET_EXHAUSTED";

export class BatchClientError extends Error {
  readonly kind: BatchClientErrorKind;

  constructor(kind: BatchClientErrorKind, message: string) {
    super(message);
    this.name = "BatchClientError";
    this.kind = kind;
  }
}

export interface BatchClientRequestOptions {
  timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Cheap, DB-only reads (preview parses a CSV/zip; progress reads a few
 * rows) — matches `review-queue-client.ts`'s own 15s ceiling. */
const DEFAULT_READ_TIMEOUT_MS = 15_000;
/** Starting a batch preprocesses every matched image sequentially
 * (`../../server/batch-start/start-batch.ts`'s own documented trade-off) —
 * generous for this project's realistic demo scale (~20-30 images, the
 * golden set); a genuinely large batch could exceed this. Not measured
 * against a real multi-hundred-image upload. */
const DEFAULT_START_TIMEOUT_MS = 300_000;

function defaultFetch(): typeof fetch {
  // `.bind(globalThis)` — see verify-client.ts's identical comment: some
  // engines throw "Illegal invocation" when `fetch` is called detached from
  // its receiver.
  return globalThis.fetch.bind(globalThis);
}

function isErrorResponse(payload: unknown, validKinds: readonly string[]): payload is { error: { kind: string; message: string } } {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return false;
  const error = (payload as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { kind, message } = error as { kind?: unknown; message?: unknown };
  return typeof kind === "string" && validKinds.includes(kind) && typeof message === "string";
}

async function readJsonBody(response: Response): Promise<unknown> {
  return response.json();
}

/** Runs one request start to finish with a live timeout, returning the
 * parsed body and the response's own `ok`/`status` — every caller below
 * layers its own success/error-shape validation on top. Centralizes the
 * "timer stays live through the body read" fix `verify-client.ts` and
 * `review-queue-client.ts` both apply independently (standing rule 23),
 * so a future batch client function inherits it automatically. */
async function runRequest(
  url: string,
  init: RequestInit,
  options: BatchClientRequestOptions,
  timeoutFallbackMs: number,
): Promise<{ ok: boolean; status: number; payload: unknown } | { ok: false; timedOutOrNetwork: true; controllerAborted: boolean }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? timeoutFallbackMs;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    clearTimeout(timeoutId);
    // `controller.signal.aborted` is the same real check
    // verify-client.ts/review-queue-client.ts use to tell "our own timeout
    // fired" from "a genuine network failure" — read here, not hardcoded,
    // so a plain network failure gets its own distinct message instead of
    // always claiming a timeout.
    return { ok: false, timedOutOrNetwork: true, controllerAborted: controller.signal.aborted };
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(response);
  } catch {
    clearTimeout(timeoutId);
    return { ok: false, timedOutOrNetwork: true, controllerAborted: controller.signal.aborted };
  }
  clearTimeout(timeoutId);

  return { ok: response.ok, status: response.status, payload };
}

function networkOrTimeoutError(controllerAborted: boolean): BatchClientError {
  return controllerAborted
    ? new BatchClientError("SERVICE", "LabelHunter took too long to respond. Check your connection and try again.")
    : new BatchClientError("SERVICE", "LabelHunter could not reach the server. Check your connection and try again.");
}

// ---- preview -----------------------------------------------------------

function isBatchPreviewSuccessResponse(payload: unknown): payload is BatchPreviewSuccessResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Partial<BatchPreviewSuccessResponse>;
  return (
    typeof body.totalRows === "number" &&
    typeof body.readyCount === "number" &&
    Array.isArray(body.matched) &&
    Array.isArray(body.unmatchedRows) &&
    Array.isArray(body.unmatchedImages) &&
    Array.isArray(body.invalidRows)
  );
}

/** Submits a batch manifest + images for a pairing preview (never starts a
 * job). Rejects with `BatchClientError` on every TH-R20 failure mode. */
export async function submitBatchPreview(formData: FormData, options: BatchClientRequestOptions = {}): Promise<BatchPreviewSuccessResponse> {
  const outcome = await runRequest("/api/batch/preview", { method: "POST", body: formData }, options, DEFAULT_READ_TIMEOUT_MS);
  if ("timedOutOrNetwork" in outcome) {
    throw networkOrTimeoutError(outcome.controllerAborted);
  }
  if (!outcome.ok) {
    if (isErrorResponse(outcome.payload, BATCH_PREVIEW_ERROR_KINDS)) {
      throw new BatchClientError(outcome.payload.error.kind as BatchClientErrorKind, outcome.payload.error.message);
    }
    throw new BatchClientError("SERVICE", "LabelHunter could not preview this batch. Try again.");
  }
  if (!isBatchPreviewSuccessResponse(outcome.payload)) {
    throw new BatchClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }
  return outcome.payload;
}

// ---- start ---------------------------------------------------------------

function isBatchStartSuccessResponse(payload: unknown): payload is BatchStartSuccessResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Partial<BatchStartSuccessResponse>;
  return (
    typeof body.batchJobId === "number" &&
    body.batchJobId > 0 &&
    typeof body.queuedCount === "number" &&
    Array.isArray(body.unmatchedRows) &&
    Array.isArray(body.unmatchedImages) &&
    Array.isArray(body.invalidRows) &&
    Array.isArray(body.skippedImages)
  );
}

/** Submits the SAME manifest + images shape as `submitBatchPreview` to
 * actually start a batch job. Rejects with `BatchClientError` on every
 * TH-R20 failure mode, including the empty-ready-set case
 * (`kind: "NO_READY_ROWS"`). */
export async function startBatch(formData: FormData, options: BatchClientRequestOptions = {}): Promise<BatchStartSuccessResponse> {
  const outcome = await runRequest("/api/batch/start", { method: "POST", body: formData }, options, DEFAULT_START_TIMEOUT_MS);
  if ("timedOutOrNetwork" in outcome) {
    throw networkOrTimeoutError(outcome.controllerAborted);
  }
  if (!outcome.ok) {
    if (isErrorResponse(outcome.payload, BATCH_START_ERROR_KINDS)) {
      throw new BatchClientError(outcome.payload.error.kind as BatchClientErrorKind, outcome.payload.error.message);
    }
    throw new BatchClientError("SERVICE", "LabelHunter could not start this batch. Try again.");
  }
  if (!isBatchStartSuccessResponse(outcome.payload)) {
    throw new BatchClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }
  return outcome.payload;
}

// ---- progress --------------------------------------------------------

function isBatchProgressResponse(payload: unknown): payload is BatchProgressResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Partial<BatchProgressResponse>;
  return (
    typeof body.batchJobId === "number" &&
    typeof body.status === "string" &&
    (BATCH_JOB_STATUSES as readonly string[]).includes(body.status) &&
    typeof body.totalCount === "number" &&
    Array.isArray(body.results)
  );
}

/** Reads one batch's live progress + results — the polling endpoint's own
 * client. Rejects with `BatchClientError`, including `kind: "NOT_FOUND"`
 * for a batch id that does not exist. */
export async function fetchBatchProgress(batchJobId: number, options: BatchClientRequestOptions = {}): Promise<BatchProgressResponse> {
  const outcome = await runRequest(`/api/batch/${batchJobId}`, { method: "GET" }, options, DEFAULT_READ_TIMEOUT_MS);
  if ("timedOutOrNetwork" in outcome) {
    throw networkOrTimeoutError(outcome.controllerAborted);
  }
  if (!outcome.ok) {
    if (isErrorResponse(outcome.payload, ["VALIDATION", "NOT_FOUND", "SERVICE"])) {
      throw new BatchClientError(outcome.payload.error.kind as BatchClientErrorKind, outcome.payload.error.message);
    }
    throw new BatchClientError("SERVICE", "LabelHunter could not load this batch's progress. Try again.");
  }
  if (!isBatchProgressResponse(outcome.payload)) {
    throw new BatchClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }
  return outcome.payload;
}

export type { BatchPreviewErrorResponse, BatchProgressErrorResponse, BatchStartErrorResponse };
