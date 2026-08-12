/**
 * Shapes for `POST /api/batch/start` (LH-042 / TRO-475, PRD §3.5, TH-R4,
 * TH-R20). Pure types and constants only — no server-only import — the same
 * discipline `src/app/api/batch/preview/types.ts` documents for its own
 * shapes.
 */
import type { ManifestRowError } from "../../../../server/batch/types";

export interface BatchStartUnmatchedRowWire {
  rowNumber: number;
  reason: string;
}

export interface BatchStartUnmatchedImageWire {
  filename: string;
  reason: string;
}

export interface BatchStartSkippedImageWire {
  filename: string;
  rowNumber: number;
  reason: string;
}

/**
 * A successful start always returns 200 with a REAL, running (or, if every
 * image failed to read, failed) batch — unlike `/api/batch/preview`, which
 * never starts anything. `unmatchedRows`/`unmatchedImages`/`invalidRows`
 * are re-reported here (not just at preview time) so nothing about this
 * specific start attempt is silently dropped (TH-R20) even if the upload
 * changed between preview and start.
 */
export interface BatchStartSuccessResponse {
  batchJobId: number;
  totalRows: number;
  /** How many labels actually became a queued, running item. */
  queuedCount: number;
  unmatchedRows: BatchStartUnmatchedRowWire[];
  unmatchedImages: BatchStartUnmatchedImageWire[];
  invalidRows: ManifestRowError[];
  /** Matched pairings whose image bytes could not actually be turned into
   * a queued label (unreadable or unsavable) — distinct from
   * `unmatchedRows`/`unmatchedImages`, which are pairing problems found
   * before any image was ever opened. */
  skippedImages: BatchStartSkippedImageWire[];
}

/**
 * `NO_READY_ROWS` is specific to this route: `/api/batch/preview` can
 * return a 200 preview with zero matched rows (a pairing problem is data,
 * not a failure, at preview time), but starting a batch with nothing to
 * queue is a dead end this route rejects outright, so the flow never
 * silently creates a batch with nothing in it.
 */
export const BATCH_START_ERROR_KINDS = ["VALIDATION", "MALFORMED_CSV", "MALFORMED_ZIP", "NO_READY_ROWS", "SERVICE"] as const;
export type BatchStartErrorKind = (typeof BATCH_START_ERROR_KINDS)[number];

export interface BatchStartErrorResponse {
  error: {
    kind: BatchStartErrorKind;
    message: string;
  };
}
