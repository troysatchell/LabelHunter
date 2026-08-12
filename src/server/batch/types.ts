/**
 * Shared types for batch manifest parsing, validation, and image pairing
 * (TRO-473 / LH-040, PRD §3.5, TH-R4, TH-R20).
 *
 * Pure types only — no server-only import (`pg`, `sharp`, `fflate`'s own
 * runtime code) — so a future UI can import this file the same way
 * `src/app/api/verify/types.ts` is safe for the client bundle to import.
 *
 * This ticket does not enqueue a batch job or start processing (LH-041,
 * LH-042 own that — see `src/server/batch/index.ts`'s file comment). What
 * it produces is a validated, paired PREVIEW: a list of
 * `{ application fields, image }` ready to hand to whatever starts the
 * job next.
 */
import type { BeverageType } from "../../lib/db/enums";

/**
 * The CSV manifest's required header row, by column name. Column ORDER in
 * the file does not matter — `parseManifest` reads by name, not position —
 * so a spreadsheet export that reorders columns still works. An extra,
 * unrecognized column is ignored, not rejected: rejecting only a MISSING
 * required column, never an unexpected extra one, is the more forgiving
 * rule for a first-time user (TH-R3).
 */
export const MANIFEST_COLUMNS = [
  "beverage_type",
  "brand_name",
  "class_type",
  "alcohol_content_percent",
  "net_contents_value",
  "net_contents_unit",
  "image_filename",
] as const;
export type ManifestColumn = (typeof MANIFEST_COLUMNS)[number];

/**
 * One valid, fully-parsed manifest row — the same application fields
 * `src/app/api/verify/parse-request.ts` collects for a single-label
 * verify, plus the `image_filename` column this ticket adds (PRD §3.5).
 *
 * `rowNumber` is 1-based and counts the header row as row 1 — the same
 * row a user would see if they opened the CSV in a spreadsheet program,
 * so an error message that names "row 4" points at the row the user would
 * actually click on.
 */
export interface ManifestRow {
  rowNumber: number;
  beverageType: BeverageType;
  brandName: string;
  classType: string;
  /** `null` when the cell was blank — legal for beer/wine, matching
   * `parse-request.ts`'s own `alcoholContentPercent` rule. */
  alcoholContentPercent: number | null;
  netContentsValue: number;
  netContentsUnit: string;
  imageFilename: string;
}

/**
 * A row that parsed structurally (the right number of cells) but failed
 * field-level validation — a bad beverage_type, a non-numeric ABV, a blank
 * required field. Reported, never silently dropped (TH-R20) — but it does
 * not invalidate any OTHER row. Compare `ParseManifestResult`'s `ok: false`
 * case, which is a whole-file, structural failure.
 */
export interface ManifestRowError {
  rowNumber: number;
  /** Plain English, ready to show a first-time user directly (TH-R20). */
  message: string;
}

/**
 * `parseManifest`'s result. Two different kinds of "wrong" are told apart
 * on purpose:
 *
 * - `ok: false` — the file itself is not usable as a manifest: unreadable
 *   CSV syntax, a missing required column, or a row whose cell count does
 *   not match the header. Any one of these makes every row's field-to-
 *   column alignment suspect, so the whole file is rejected with one
 *   plain-English message, rather than guessing which cells still mean
 *   what they say.
 * - `ok: true` — the file parsed structurally. `rows` holds every row that
 *   also passed field-level validation; `rowErrors` holds every row that
 *   did not, each with its own reason. Neither list drops information the
 *   other could have reported instead — every data row in the file ends
 *   up in exactly one of the two.
 */
export type ParseManifestResult =
  | { ok: false; message: string }
  | { ok: true; rows: ManifestRow[]; rowErrors: ManifestRowError[] };

/** One uploaded image, however it arrived (a multi-file drop entry, or one
 * entry inside an uploaded zip) — enough information to pair it against a
 * manifest row by filename and to report a problem with it. Deliberately
 * does not carry the image's bytes: this ticket never decodes or stores
 * image content (TH-R20's "bad image" state belongs to the extractor
 * worker that actually reads pixels — LH-041 — not this pairing step). */
export interface BatchImageRef {
  /** The image's own filename, with any directory path stripped (a zip
   * entry's path is never used as-is — see `zip.ts`'s file comment). */
  filename: string;
  sizeBytes: number;
}

/** One manifest row successfully paired to exactly one uploaded image —
 * the unit of work a future "start batch" step (LH-041/LH-042) would turn
 * into an `applications` + `label_images` + `batch_queue_items` row set. */
export interface PairedItem {
  row: ManifestRow;
  image: BatchImageRef;
}

/** A manifest row this batch cannot process yet: no image matches its
 * `image_filename`, more than one row claims the same image, or more than
 * one uploaded image shares that filename. `reason` is plain English,
 * ready to show directly (TH-R20). Reported, never silently dropped or
 * silently processed with a missing piece (this ticket's brief, quoted). */
export interface UnmatchedManifestRow {
  row: ManifestRow;
  reason: string;
}

/** An uploaded image this batch cannot use yet: no CSV row names it, more
 * than one row claims it, more than one upload shares its filename, or the
 * file is empty. Same reporting rule as `UnmatchedManifestRow`. */
export interface UnmatchedBatchImage {
  image: BatchImageRef;
  reason: string;
}

/** `pairRowsWithImages`'s result — every valid manifest row and every
 * uploaded image accounted for in exactly one of the three lists below.
 * Nothing is dropped; nothing appears twice. */
export interface PairingResult {
  matched: PairedItem[];
  unmatchedRows: UnmatchedManifestRow[];
  unmatchedImages: UnmatchedBatchImage[];
}

/**
 * `buildBatchPreview`'s result — the top-level shape this ticket hands
 * off (see `index.ts`'s file comment for the exact handoff contract).
 *
 * `ok: false` mirrors `ParseManifestResult`'s own structural failure: the
 * CSV manifest itself could not be read. A pairing problem (an unmatched
 * row or image) is NOT this case — it is data inside a successful preview,
 * because "some rows don't have a picture yet" is information for the user
 * to review, not a reason to fail the whole upload (TH-R20: reported,
 * never silently dropped — the brief's own words say "reported", not
 * "rejected").
 */
export type BatchPreviewResult =
  | { ok: false; message: string }
  | {
      ok: true;
      /** Every data row the CSV contained, valid or not — `rows.length +
       * rowErrors.length` from `parseManifest`, kept as one number so a
       * summary line ("237 of 240 rows ready") needs no extra math. */
      totalRows: number;
      /** `matched.length` — how many labels are actually ready to
       * process once a later step starts the job. */
      readyCount: number;
      matched: PairedItem[];
      unmatchedRows: UnmatchedManifestRow[];
      unmatchedImages: UnmatchedBatchImage[];
      invalidRows: ManifestRowError[];
    };
