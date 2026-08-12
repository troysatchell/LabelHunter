/**
 * POST /api/batch/start — turns an accepted batch preview into a real,
 * running batch job (LH-042 / TRO-475, PRD §3.5, TH-R4, TH-R20).
 *
 * **The gap this route closes.** `POST /api/batch/preview` (LH-040) never
 * starts a job — its own file comment names this route's ticket as the one
 * that does. LH-041 built the queue and worker pool but never wired a
 * caller to them either (`scripts/batch-worker/run.ts`'s own file comment:
 * "does not... flip a batch to RUNNING"). This route is that caller: it
 * re-parses the SAME multipart upload shape `/api/batch/preview` accepts
 * (CSV manifest + images, zip or multi-file drop), re-derives the pairing
 * (deterministic and cheap — never trusts a client-supplied pairing
 * decision, standing rule 13), resolves REAL bytes for every matched image,
 * and hands them to `startBatchFromPairings`
 * (`../../../../server/batch-start`), which creates `applications` +
 * `label_images` rows and enqueues the batch through LH-041's own,
 * untouched `enqueueExtractItems` + `startBatchJob`.
 *
 * Reuses `/api/batch/preview/route.ts`'s own exported request-size guards
 * (`checkRequestSize`, `readLimitedBody`) and `parse-request.ts`'s
 * `parseBatchPreviewFormData` directly, rather than re-implementing them —
 * this route's own multipart shape and size ceilings are identical to
 * preview's.
 *
 * A pairing problem (an unmatched row, an unmatched image, an invalid row)
 * is reported here exactly as it is at preview time — never a request
 * failure by itself — because the SAME upload can differ slightly between
 * a preview call and a start call (a network retry, a user editing files in
 * between). Only a genuinely empty ready set (`NO_READY_ROWS`) rejects the
 * request outright: starting a batch with nothing to queue would create a
 * dead end, not a batch.
 */
import { NextResponse } from "next/server";
import { buildBatchPreview } from "../../../../server/batch";
import { MAX_IMAGE_COUNT, MAX_TOTAL_REQUEST_BYTES } from "../../../../server/batch/constants";
import { extractZipEntries } from "../../../../server/batch/zip";
import type { BatchImageRef } from "../../../../server/batch/types";
import { extractZipImageBytes, startBatchFromPairings, type StartBatchPairingInput, type StartBatchResult } from "../../../../server/batch-start";
import { checkRequestSize, readLimitedBody } from "../preview/route";
import { parseBatchPreviewFormData } from "../preview/parse-request";
import type { BatchStartErrorKind, BatchStartErrorResponse, BatchStartSuccessResponse } from "./types";

function errorResponse(status: number, kind: BatchStartErrorKind, message: string): NextResponse<BatchStartErrorResponse> {
  return NextResponse.json({ error: { kind, message } }, { status });
}

export interface HandleBatchStartOptions {
  maxTotalRequestBytes?: number;
  /** Injectable — defaults to the real `startBatchFromPairings`. Tests
   * override this to point `saveLabelImage` at a scratch directory, the
   * same DI shape `src/app/api/verify/route.ts`'s `VerifyRouteDeps` uses. */
  startBatch?: (pairings: StartBatchPairingInput[]) => Promise<StartBatchResult>;
}

const defaultStartBatch = (pairings: StartBatchPairingInput[]): Promise<StartBatchResult> => startBatchFromPairings(pairings);

const NO_READY_ROWS_MESSAGE = "No rows are ready to start. Fix the unmatched rows or images and try again.";

export async function handleBatchStartRequest(request: Request, options: HandleBatchStartOptions = {}): Promise<Response> {
  const maxTotalRequestBytes = options.maxTotalRequestBytes ?? MAX_TOTAL_REQUEST_BYTES;
  const startBatch = options.startBatch ?? defaultStartBatch;

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

  let zipBytes: Uint8Array | null = null;
  if (input.imagesZip) {
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
  if (preview.matched.length === 0) {
    return errorResponse(422, "NO_READY_ROWS", NO_READY_ROWS_MESSAGE);
  }

  // Resolve REAL bytes for every matched pairing — `buildBatchPreview`
  // itself never decodes or stores a byte (see its own file comment). A
  // matched filename came from exactly one of two sources: an individual
  // multi-file-drop entry (bytes already in `input.imageFiles`), or a zip
  // entry (bytes need real decompression, `extractZipImageBytes`). Never
  // both — a filename two sources share is routed to `unmatchedImages` by
  // the pairing step itself, before it can ever reach `matched`.
  const fileByName = new Map(input.imageFiles.map((file) => [file.name, file] as const));
  const wantedZipFilenames = new Set(preview.matched.map((item) => item.image.filename).filter((filename) => !fileByName.has(filename)));

  let zipByteMap = new Map<string, Uint8Array>();
  if (wantedZipFilenames.size > 0) {
    if (!zipBytes) {
      // Unreachable under normal operation: a matched filename not among
      // `input.imageFiles` can only have come from the zip, by
      // `buildBatchPreview`'s own construction. Defensive (standing rule
      // 13), not a real code path.
      return errorResponse(503, "SERVICE", "LabelHunter could not process this upload. Try again.");
    }
    const zipImagesResult = extractZipImageBytes(zipBytes, wantedZipFilenames);
    if (!zipImagesResult.ok) {
      return errorResponse(422, "MALFORMED_ZIP", zipImagesResult.message);
    }
    zipByteMap = zipImagesResult.images;
  }

  const pairings: StartBatchPairingInput[] = [];
  for (const item of preview.matched) {
    const file = fileByName.get(item.image.filename);
    const bytes = file ? Buffer.from(await file.arrayBuffer()) : zipByteMap.has(item.image.filename) ? Buffer.from(zipByteMap.get(item.image.filename) as Uint8Array) : null;
    if (!bytes) continue; // unreachable under normal operation — see the comment above
    pairings.push({ row: item.row, filename: item.image.filename, bytes });
  }

  if (pairings.length === 0) {
    return errorResponse(422, "NO_READY_ROWS", NO_READY_ROWS_MESSAGE);
  }

  let result: StartBatchResult;
  try {
    result = await startBatch(pairings);
  } catch (cause) {
    console.error("Could not start batch", cause);
    return errorResponse(503, "SERVICE", "LabelHunter could not start this batch. Try again.");
  }

  const body: BatchStartSuccessResponse = {
    batchJobId: result.batchJobId,
    totalRows: preview.totalRows,
    queuedCount: result.queuedCount,
    unmatchedRows: preview.unmatchedRows.map((row) => ({ rowNumber: row.row.rowNumber, reason: row.reason })),
    unmatchedImages: preview.unmatchedImages.map((image) => ({ filename: image.image.filename, reason: image.reason })),
    invalidRows: preview.invalidRows,
    skippedImages: result.skippedImages,
  };
  return NextResponse.json(body, { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  return handleBatchStartRequest(request);
}
