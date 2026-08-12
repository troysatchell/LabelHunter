/**
 * POST /api/batch/preview — the batch input pairing-preview flow
 * (TRO-473 / LH-040, PRD §3.5, TH-R4, TH-R20).
 *
 * Accepts a CSV manifest plus label images — either as individual
 * multi-file-drop entries, a zip archive, or both at once — and returns a
 * validated, paired PREVIEW: which rows matched an image, which rows or
 * images did not, and which rows failed field-level validation. It never
 * starts a batch job. See `src/server/batch/index.ts`'s file comment for
 * the exact handoff contract this ticket produces for whatever enqueues
 * the job next (LH-041/LH-042 — not built here, and `batch_queue_items`
 * does not exist on this branch to write to even if it were).
 *
 * A pairing problem (an unmatched row, an unmatched image, an invalid
 * row) is never a request-level failure — it is data inside a successful
 * 200 response, exactly the "reported... never silently dropped" rule
 * this ticket's brief states. Only a request the server genuinely cannot
 * turn into a preview at all (no manifest, an unreadable CSV, a corrupt
 * zip, too many images) returns a designed error response.
 */
import { NextResponse } from "next/server";
import { buildBatchPreview } from "../../../../server/batch";
import { MAX_IMAGE_COUNT, MAX_TOTAL_REQUEST_BYTES } from "../../../../server/batch/constants";
import { extractZipEntries } from "../../../../server/batch/zip";
import type { BatchImageRef } from "../../../../server/batch/types";
import { parseBatchPreviewFormData } from "./parse-request";
import type { BatchPreviewErrorKind, BatchPreviewErrorResponse, BatchPreviewSuccessResponse } from "./types";

function errorResponse(status: number, kind: BatchPreviewErrorKind, message: string): NextResponse<BatchPreviewErrorResponse> {
  return NextResponse.json({ error: { kind, message } }, { status });
}

function tooLargeMessage(maxBytes: number): string {
  const limitGb = (maxBytes / (1024 * 1024 * 1024)).toFixed(1);
  return `This upload is too large. The limit is ${limitGb} GB. Split it into smaller batches.`;
}

/**
 * Rejects a request whose declared `Content-Length` alone already exceeds
 * `maxBytes`, before anything reads a byte of the body — a fast path that
 * skips buffering a multi-gigabyte body just to discover it is too large.
 * Exported so it is directly unit-testable against a `Request`'s headers
 * alone, without needing a real oversized body to prove the rejection.
 *
 * **This is a fast path, not the authoritative check** (review finding).
 * A request with no `Content-Length` header at all — chunked transfer-
 * encoding, or (confirmed empirically) Node's own `Request`
 * implementation for a `FormData` body, which never sets one — passes
 * this check with `{ ok: true }` every time, honest or not. That case is
 * not a hypothetical: it is this route's own normal shape in
 * production, since a real `FormData` upload commonly arrives with no
 * `Content-Length` header at all. `readLimitedBody`, below, is what
 * actually enforces the cap for every request, with or without this
 * header — this function only saves the cost of reading anything at all
 * for the common case where the header is present and already reveals
 * the request is too large.
 */
export function checkRequestSize(
  request: Request,
  maxBytes: number = MAX_TOTAL_REQUEST_BYTES,
): { ok: true } | { ok: false; message: string } {
  const raw = request.headers.get("content-length");
  if (raw === null) return { ok: true };
  const declaredBytes = Number(raw);
  if (!Number.isFinite(declaredBytes) || declaredBytes <= maxBytes) return { ok: true };
  return { ok: false, message: tooLargeMessage(maxBytes) };
}

/**
 * Reads `request`'s REAL body bytes, aborting the read the moment more
 * than `maxBytes` has actually arrived — measured, not declared. This is
 * the authoritative cap `checkRequestSize` above cannot be on its own: a
 * request with a missing, understated, or absent `Content-Length` header
 * sails straight through that check, and previously sailed straight
 * into an uncapped `request.formData()` too (review finding — the gap
 * this function closes). `Request.body` is only readable once, so the
 * bytes this function collects are what the rest of the route re-parses
 * as `FormData` — see the `Response(...).formData()` call below, which
 * re-parses the SAME bytes rather than a second read of the original
 * (already-consumed) stream.
 *
 * Returns a `Blob`, not a manually concatenated `Uint8Array` (review
 * finding, critical). An earlier draft accumulated every chunk and THEN
 * allocated a second, full-body-sized `Uint8Array` to merge them into —
 * a real request near `maxBytes` briefly held roughly twice its own size
 * in memory, on a route whose entire purpose is bounding memory use.
 * `new Blob(chunks)` needs no such second full-size copy (confirmed
 * empirically: `Response(blob, ...).formData()` re-parses correctly from
 * a `Blob` built directly from the reader's own chunks), and is itself
 * wrapped in a `try`/`catch` — a construction failure now reaches this
 * function's own designed error return, not an uncaught throw escaping
 * to the caller.
 */
export async function readLimitedBody(
  request: Request,
  maxBytes: number = MAX_TOTAL_REQUEST_BYTES,
): Promise<{ ok: true; body: Blob } | { ok: false; message: string }> {
  if (!request.body) {
    return { ok: true, body: new Blob([]) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, message: tooLargeMessage(maxBytes) };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, message: "LabelHunter could not read this upload. Try again." };
  }

  try {
    // The cast is a type-only gap, not a behavioral one (same class this
    // file already documents for `Response`'s own `BodyInit`): a
    // `ReadableStreamDefaultReader<Uint8Array>` chunk's inferred
    // `Uint8Array<ArrayBufferLike>` type does not satisfy this
    // TypeScript/DOM-lib version's stricter `BlobPart` (`ArrayBuffer`-only)
    // member, even though `new Blob(...)` accepts it at runtime — proven
    // by every test in `route.test.ts` that exercises this exact path.
    return { ok: true, body: new Blob(chunks as unknown as BlobPart[]) };
  } catch {
    return { ok: false, message: "LabelHunter could not read this upload. Try again." };
  }
}

export interface HandleBatchPreviewLimits {
  maxTotalRequestBytes?: number;
}

export async function handleBatchPreviewRequest(
  request: Request,
  limits: HandleBatchPreviewLimits = {},
): Promise<Response> {
  const maxTotalRequestBytes = limits.maxTotalRequestBytes ?? MAX_TOTAL_REQUEST_BYTES;

  const sizeCheck = checkRequestSize(request, maxTotalRequestBytes);
  if (!sizeCheck.ok) {
    return errorResponse(400, "VALIDATION", sizeCheck.message);
  }

  const bodyResult = await readLimitedBody(request, maxTotalRequestBytes);
  if (!bodyResult.ok) {
    return errorResponse(400, "VALIDATION", bodyResult.message);
  }

  let formData: FormData;
  try {
    // Re-parses the SAME bytes readLimitedBody already collected — the
    // original request's own body stream is already fully consumed by
    // now, and can only ever be read once. `Blob` is a `BodyInit` member
    // TypeScript recognizes natively — no cast needed here, unlike the
    // `Uint8Array` an earlier draft passed directly.
    const contentType = request.headers.get("content-type") ?? "";
    formData = await new Response(bodyResult.body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return errorResponse(400, "VALIDATION", "LabelHunter could not read this upload. Try again.");
  }

  const parsed = parseBatchPreviewFormData(formData);
  if (!parsed.ok) {
    return errorResponse(400, "VALIDATION", parsed.message);
  }
  const input = parsed.value;

  const images: BatchImageRef[] = input.imageFiles.map((file) => ({ filename: file.name, sizeBytes: file.size }));

  if (input.imagesZip) {
    let zipBytes: Uint8Array;
    try {
      zipBytes = new Uint8Array(await input.imagesZip.arrayBuffer());
    } catch {
      return errorResponse(503, "SERVICE", "LabelHunter could not read the uploaded zip file. Try again.");
    }
    const zipResult = extractZipEntries(zipBytes);
    if (!zipResult.ok) {
      return errorResponse(422, "MALFORMED_ZIP", zipResult.message);
    }
    images.push(...zipResult.images);
  }

  if (images.length > MAX_IMAGE_COUNT) {
    return errorResponse(
      400,
      "VALIDATION",
      `This batch has too many images (${images.length}). The limit is ${MAX_IMAGE_COUNT}. Split it into smaller batches.`,
    );
  }

  let csvText: string;
  try {
    csvText = await input.manifest.text();
  } catch {
    return errorResponse(503, "SERVICE", "LabelHunter could not read the manifest file. Try again.");
  }

  let preview;
  try {
    preview = buildBatchPreview({ csvText, images });
  } catch {
    return errorResponse(503, "SERVICE", "LabelHunter could not process this upload. Try again.");
  }

  if (!preview.ok) {
    return errorResponse(422, "MALFORMED_CSV", preview.message);
  }

  const body: BatchPreviewSuccessResponse = {
    totalRows: preview.totalRows,
    readyCount: preview.readyCount,
    matched: preview.matched,
    unmatchedRows: preview.unmatchedRows,
    unmatchedImages: preview.unmatchedImages,
    invalidRows: preview.invalidRows,
  };
  return NextResponse.json(body, { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  return handleBatchPreviewRequest(request);
}
