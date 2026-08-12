/**
 * `buildBatchPreview` — the facade this ticket hands off (TRO-473 / LH-040,
 * PRD §3.5, TH-R4, TH-R20). Same convention as `server/router/index.ts` and
 * `server/resolver/index.ts`: one orchestration entry point, re-exporting
 * the types a caller needs, so nothing outside `server/batch/` has to know
 * this feature is split across `csv.ts` / `manifest.ts` / `pairing.ts` /
 * `zip.ts`.
 *
 * **The handoff contract, stated plainly.** This ticket's brief: "Produce
 * a clean, validated, paired result — a list of {application fields,
 * image} ready to hand to whatever enqueues it." `buildBatchPreview` is
 * that list, plus everything TH-R20 requires reported alongside it
 * (unmatched rows, unmatched images, invalid rows) — never a started job.
 *
 * This module does not:
 * - write to the database (no `batch_jobs`, `applications`, or
 *   `label_images` row is created here — see `docs/checkpoints/
 *   cp3-batch-queue.md` §10, which assumes a `batch_jobs` row exists only
 *   once pairing has already succeeded, i.e. AFTER this step, not during
 *   it);
 * - enqueue a `batch_queue_items` row (that table does not exist on this
 *   branch — it is added by LH-041's own migration, running in a sibling
 *   worktree; see the checkpoint doc §2.2);
 * - decode or store image bytes (no `sharp` call — a bad image's pixel
 *   data is the EXTRACT worker's concern, per the checkpoint doc §5.1,
 *   not this pairing step's).
 *
 * `BatchPreviewResult["matched"]` (`PairedItem[]`, from `./types`) is
 * exactly the `{ application fields, image }` list a future "start batch"
 * step consumes to create those rows — `PairedItem.row` carries every
 * `applications` column this ticket's CSV format collects, and
 * `PairedItem.image` carries the filename a later step resolves back to
 * real bytes (from whichever multi-file entry or zip entry produced it).
 */
import { parseManifest } from "./manifest";
import { pairRowsWithImages } from "./pairing";
import type { BatchImageRef, BatchPreviewResult } from "./types";

export interface BuildBatchPreviewInput {
  csvText: string;
  images: BatchImageRef[];
}

export function buildBatchPreview(input: BuildBatchPreviewInput): BatchPreviewResult {
  const manifestResult = parseManifest(input.csvText);
  if (!manifestResult.ok) {
    return { ok: false, message: manifestResult.message };
  }

  const pairing = pairRowsWithImages(manifestResult.rows, input.images);

  return {
    ok: true,
    totalRows: manifestResult.rows.length + manifestResult.rowErrors.length,
    readyCount: pairing.matched.length,
    matched: pairing.matched,
    unmatchedRows: pairing.unmatchedRows,
    unmatchedImages: pairing.unmatchedImages,
    invalidRows: manifestResult.rowErrors,
  };
}

export type {
  BatchImageRef,
  BatchPreviewResult,
  ManifestRow,
  ManifestRowError,
  PairedItem,
  PairingResult,
  UnmatchedBatchImage,
  UnmatchedManifestRow,
} from "./types";
