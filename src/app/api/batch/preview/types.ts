/**
 * Shapes for `POST /api/batch/preview` (TRO-473 / LH-040, PRD §3.5,
 * TH-R4, TH-R20).
 *
 * Pure types and pure constants only — no server-only import — mirroring
 * `src/app/api/verify/types.ts`'s own doc comment: safe for a future
 * client bundle to import directly.
 */
import type {
  BatchImageRef,
  ManifestRow,
  ManifestRowError,
} from "../../../../server/batch/types";

export interface BatchPreviewPairedItem {
  row: ManifestRow;
  image: BatchImageRef;
}

export interface BatchPreviewUnmatchedRow {
  row: ManifestRow;
  reason: string;
}

export interface BatchPreviewUnmatchedImage {
  image: BatchImageRef;
  reason: string;
}

/**
 * A successful upload always returns 200 with a PREVIEW, never a started
 * job — this ticket does not start jobs (LH-041/LH-042 own the queue and
 * the run step). An unmatched row, an unmatched image, or an invalid row
 * is information for the pairing-preview screen, never a request-level
 * failure by itself: TH-R20 asks for these to be "reported... never
 * silently dropped," not rejected outright.
 */
export interface BatchPreviewSuccessResponse {
  totalRows: number;
  readyCount: number;
  matched: BatchPreviewPairedItem[];
  unmatchedRows: BatchPreviewUnmatchedRow[];
  unmatchedImages: BatchPreviewUnmatchedImage[];
  invalidRows: ManifestRowError[];
}

/**
 * Which designed error state (TH-R20) the response represents when the
 * upload itself could not be turned into a preview at all — as opposed to
 * a preview that has unmatched items, which is still a 200 (see
 * `BatchPreviewSuccessResponse`'s own doc comment). Mirrors
 * `src/app/api/verify/types.ts`'s `VERIFY_ERROR_KINDS` pattern: the array
 * is the source of truth, the type is derived from it, and a client can
 * check an HTTP response's `kind` against this array at runtime before
 * trusting it.
 */
export const BATCH_PREVIEW_ERROR_KINDS = ["VALIDATION", "MALFORMED_CSV", "MALFORMED_ZIP", "SERVICE"] as const;
export type BatchPreviewErrorKind = (typeof BATCH_PREVIEW_ERROR_KINDS)[number];

export interface BatchPreviewErrorResponse {
  error: {
    kind: BatchPreviewErrorKind;
    message: string;
  };
}
