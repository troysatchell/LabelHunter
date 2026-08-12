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

/**
 * Rejects a request whose declared `Content-Length` alone already exceeds
 * `maxBytes`, before `request.formData()` ever runs (review finding) —
 * buffering a multi-gigabyte body just to discover it is too large is
 * exactly the cost this check exists to skip. Exported so it is directly
 * unit-testable against a `Request`'s headers alone, without needing a
 * real oversized body to prove the rejection.
 *
 * A request with no `Content-Length` header at all — for example,
 * chunked transfer-encoding, or (confirmed empirically) Node's own
 * `Request` implementation for a `FormData` body, which never sets one —
 * is NOT rejected here. This check defends the case where the header is
 * present and honest; it is not a guarantee against every request shape
 * a client could send, and every per-field check later in this route
 * (`parse-request.ts`, `zip.ts`) still runs regardless.
 */
export function checkRequestSize(
  request: Request,
  maxBytes: number = MAX_TOTAL_REQUEST_BYTES,
): { ok: true } | { ok: false; message: string } {
  const raw = request.headers.get("content-length");
  if (raw === null) return { ok: true };
  const declaredBytes = Number(raw);
  if (!Number.isFinite(declaredBytes) || declaredBytes <= maxBytes) return { ok: true };
  const limitGb = (maxBytes / (1024 * 1024 * 1024)).toFixed(1);
  return { ok: false, message: `This upload is too large. The limit is ${limitGb} GB. Split it into smaller batches.` };
}

export async function handleBatchPreviewRequest(request: Request): Promise<Response> {
  const sizeCheck = checkRequestSize(request);
  if (!sizeCheck.ok) {
    return errorResponse(400, "VALIDATION", sizeCheck.message);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
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
