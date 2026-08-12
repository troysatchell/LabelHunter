/**
 * Deterministic filename pairing between manifest rows and uploaded images
 * (TRO-473 / LH-040, PRD §3.5, TH-R4, TH-R20).
 *
 * "Deterministic" means: pairing depends only on the filename strings
 * themselves, never on upload order, array position, or which of two
 * same-named files happened to arrive first. Every row and every image
 * ends up in exactly one of `matched`, `unmatchedRows`, or
 * `unmatchedImages` — nothing is dropped, and nothing is silently paired
 * with a piece that might be wrong (this ticket's brief, quoted almost
 * verbatim in the module doc for `types.ts`).
 *
 * Filename comparison is exact after Unicode NFC normalization (standing
 * rule 20): two names that render identically on screen but arrived in
 * different Unicode forms still match; two names differing only in case
 * do NOT match — deliberately, matching this schema's own future
 * `label_images_batch_filename_unique` index, which Postgres also
 * compares case-sensitively (`src/lib/db/schema.ts`).
 */
import type { BatchImageRef, ManifestRow, PairingResult, UnmatchedBatchImage } from "./types";

function normalizeFilename(name: string): string {
  return name.normalize("NFC");
}

export function pairRowsWithImages(rows: ManifestRow[], images: BatchImageRef[]): PairingResult {
  // Zero-byte uploads are their own problem — report and set aside before
  // any pairing logic runs, so an empty file never "matches" a row just
  // because the names line up. `emptyImageKeys` lets the row-side loop
  // below tell "no file at all" apart from "a file, but it's empty" —
  // two different problems that need two different messages (review
  // finding).
  const emptyImages: UnmatchedBatchImage[] = [];
  const emptyImageKeys = new Set<string>();
  const usableImages: BatchImageRef[] = [];
  for (const image of images) {
    if (image.sizeBytes === 0) {
      emptyImages.push({ image, reason: "This file is empty." });
      emptyImageKeys.add(normalizeFilename(image.filename));
    } else {
      usableImages.push(image);
    }
  }

  const rowsByFilename = new Map<string, ManifestRow[]>();
  for (const r of rows) {
    const key = normalizeFilename(r.imageFilename);
    const list = rowsByFilename.get(key);
    if (list) list.push(r);
    else rowsByFilename.set(key, [r]);
  }

  const imagesByFilename = new Map<string, BatchImageRef[]>();
  for (const image of usableImages) {
    const key = normalizeFilename(image.filename);
    const list = imagesByFilename.get(key);
    if (list) list.push(image);
    else imagesByFilename.set(key, [image]);
  }

  const matched: PairingResult["matched"] = [];
  const unmatchedRows: PairingResult["unmatchedRows"] = [];

  for (const [key, rowsForKey] of rowsByFilename) {
    const imagesForKey = imagesByFilename.get(key) ?? [];

    if (rowsForKey.length > 1) {
      for (const r of rowsForKey) {
        unmatchedRows.push({
          row: r,
          reason: `More than one row names the image "${r.imageFilename}". Give each image its own row.`,
        });
      }
      continue;
    }

    const r = rowsForKey[0];
    if (imagesForKey.length === 0) {
      const reason = emptyImageKeys.has(key)
        ? `The uploaded image "${r.imageFilename}" is empty.`
        : `No uploaded image is named "${r.imageFilename}".`;
      unmatchedRows.push({ row: r, reason });
    } else if (imagesForKey.length > 1) {
      unmatchedRows.push({
        row: r,
        reason: `More than one uploaded image is named "${r.imageFilename}". Remove the duplicate file.`,
      });
    } else {
      matched.push({ row: r, image: imagesForKey[0] });
    }
  }

  // Every image in `imagesForKey` is reported in each non-unique-match
  // branch below, not only the first — the module's own documented
  // contract is "every uploaded image ends up in exactly one output
  // list," and a filename with 3 duplicate uploads has 3 images that
  // each need their own entry, not 1 (review finding).
  const unmatchedImages: PairingResult["unmatchedImages"] = [...emptyImages];
  for (const [key, imagesForKey] of imagesByFilename) {
    const rowsForKey = rowsByFilename.get(key) ?? [];

    if (rowsForKey.length === 0) {
      for (const image of imagesForKey) {
        unmatchedImages.push({ image, reason: "No CSV row names this file." });
      }
    } else if (rowsForKey.length > 1) {
      for (const image of imagesForKey) {
        unmatchedImages.push({
          image,
          reason: `More than one CSV row names this file (${rowsForKey.length} rows). Give each image its own row.`,
        });
      }
    } else if (imagesForKey.length > 1) {
      for (const image of imagesForKey) {
        unmatchedImages.push({
          image,
          reason: `More than one uploaded file is named "${image.filename}". Remove the duplicate.`,
        });
      }
    }
    // rowsForKey.length === 1 && imagesForKey.length === 1 -> matched above; nothing to report here.
  }

  return { matched, unmatchedRows, unmatchedImages };
}
