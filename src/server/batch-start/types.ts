/**
 * Shapes for turning an accepted batch preview into a running batch job
 * (LH-042 / TRO-475, PRD §3.5). Pure types only — no server-only import —
 * matching `src/server/batch/types.ts`'s own discipline: a future client
 * bundle can import this file safely.
 */
import type { ManifestRow } from "../batch/types";

/** One matched pairing, with the image's REAL bytes attached — the one
 * thing `PairedItem` (`../batch/types.ts`) deliberately does not carry
 * (that type only has a filename + declared size; see its own doc comment).
 * `filename` is carried separately from `row.imageFilename` only for
 * clarity at call sites — the two are always equal for a pairing that
 * passed `buildBatchPreview`. */
export interface StartBatchPairingInput {
  row: ManifestRow;
  filename: string;
  bytes: Buffer;
}

/** One matched pairing whose image bytes could not actually be turned into
 * a queued label — reported, never silently dropped (TH-R20), the same
 * rule `../batch/types.ts`'s `UnmatchedManifestRow`/`UnmatchedBatchImage`
 * already state for a pairing problem found at the earlier preview step. */
export interface StartBatchSkippedImage {
  filename: string;
  rowNumber: number;
  /** Plain English, ready to show a first-time user directly (TH-R20) —
   * `PreprocessingError`'s own message (`../preprocessing/errors.ts`) when
   * the cause is a recognized preprocessing failure, or a generic fallback
   * otherwise. */
  reason: string;
}

export interface StartBatchResult {
  batchJobId: number;
  /** How many labels actually became a queued `EXTRACT` item — may be less
   * than `pairings.length` when one or more images could not be read (see
   * `skippedImages`). */
  queuedCount: number;
  skippedImages: StartBatchSkippedImage[];
}
