/**
 * Turns an accepted batch preview's matched pairings into a running batch
 * job. It is the caller that connects the preview to the queue: the
 * preview writes nothing, and the worker pool never flips a batch to
 * RUNNING.
 *
 * Per pairing it mirrors the single-label shape — preprocess the image,
 * save the original, insert `applications` and `label_images`. It then
 * hands the whole set to `enqueueExtractItems` and `startBatchJob`. It
 * owns no queue logic itself.
 *
 * **One bad image fails that pairing, never the batch** (PRD §3.5). A
 * pairing whose image will not decode comes back in `skippedImages`, never
 * silently dropped. If every pairing fails, the batch is marked FAILED
 * rather than left RUNNING at `totalCount = 0` — an empty running batch
 * would never reach COMPLETED.
 *
 * Ingestion is sequential on purpose. PRD §3.5's "never serial" rule
 * targets extraction throughput once a batch runs; this is a one-time
 * step. It is not measured against a multi-hundred-image upload, so
 * bounded concurrency here is open work if that turns out to matter.
 */
import { db as defaultDb } from "../../lib/db";
import { applications, batchJobs, labelImages } from "../../lib/db/schema";
import { enqueueExtractItems, startBatchJob } from "../batch-queue";
import { preprocessImage as defaultPreprocessImage, PreprocessingError, type PreprocessedImage } from "../preprocessing";
import { saveLabelImage as defaultSaveLabelImage, type SavedLabelImage } from "../storage/db-image-storage";
import { eq } from "drizzle-orm";
import type { StartBatchPairingInput, StartBatchResult, StartBatchSkippedImage } from "./types";

type Db = typeof defaultDb;

export interface StartBatchDeps {
  db: Db;
  preprocessImage: (upload: Buffer) => Promise<PreprocessedImage>;
  saveLabelImage: (bytes: Buffer, originalFilename: string) => Promise<SavedLabelImage>;
}

const defaultDeps: StartBatchDeps = {
  db: defaultDb,
  preprocessImage: defaultPreprocessImage,
  saveLabelImage: defaultSaveLabelImage,
};

const GENERIC_UNREADABLE_MESSAGE = "LabelHunter could not read this photo.";
const GENERIC_SAVE_FAILURE_MESSAGE = "LabelHunter could not save this photo.";

export async function startBatchFromPairings(pairings: StartBatchPairingInput[], deps: Partial<StartBatchDeps> = {}): Promise<StartBatchResult> {
  const d: StartBatchDeps = { ...defaultDeps, ...deps };

  const [batchJobRow] = await d.db.insert(batchJobs).values({ status: "PENDING", totalCount: 0 }).returning({ id: batchJobs.id });
  const batchJobId = batchJobRow.id;

  const skippedImages: StartBatchSkippedImage[] = [];
  const queuedPairs: { applicationId: number; labelImageId: number }[] = [];

  for (const pairing of pairings) {
    let preprocessed: PreprocessedImage;
    try {
      preprocessed = await d.preprocessImage(pairing.bytes);
    } catch (cause) {
      const reason = cause instanceof PreprocessingError ? cause.message : GENERIC_UNREADABLE_MESSAGE;
      skippedImages.push({ filename: pairing.filename, rowNumber: pairing.row.rowNumber, reason });
      continue;
    }

    let saved: SavedLabelImage;
    try {
      saved = await d.saveLabelImage(preprocessed.original, pairing.filename);
    } catch {
      skippedImages.push({ filename: pairing.filename, rowNumber: pairing.row.rowNumber, reason: GENERIC_SAVE_FAILURE_MESSAGE });
      continue;
    }

    const row = pairing.row;
    const pair = await d.db.transaction(async (tx) => {
      const [applicationRow] = await tx
        .insert(applications)
        .values({
          batchJobId,
          beverageType: row.beverageType,
          brandName: row.brandName,
          classType: row.classType,
          alcoholContentRaw: row.alcoholContentPercent !== null ? `${row.alcoholContentPercent}%` : null,
          abvPercent: row.alcoholContentPercent,
          netContentsRaw: `${row.netContentsValue} ${row.netContentsUnit}`,
          netContentsValue: row.netContentsValue,
          netContentsUnit: row.netContentsUnit,
        })
        .returning();

      const [labelImageRow] = await tx
        .insert(labelImages)
        .values({
          batchJobId,
          applicationId: applicationRow.id,
          storagePath: saved.storagePath,
          originalFilename: pairing.filename,
          widthPx: preprocessed.width,
          heightPx: preprocessed.height,
        })
        .returning();

      return { applicationId: applicationRow.id, labelImageId: labelImageRow.id };
    });

    queuedPairs.push(pair);
  }

  if (queuedPairs.length === 0) {
    // Every pairing's image was unreadable or unsavable — nothing can ever
    // run. Mark the job FAILED explicitly rather than leave it RUNNING with
    // totalCount = 0: an empty running batch would never reach COMPLETED,
    // since `maybeCompleteBatchJob` (`../batch-queue`) only ever fires from
    // a queue item's own completion, and there would be none.
    await d.db.update(batchJobs).set({ status: "FAILED" }).where(eq(batchJobs.id, batchJobId));
    return { batchJobId, queuedCount: 0, skippedImages };
  }

  const queuedCount = await enqueueExtractItems(d.db, batchJobId, queuedPairs);
  await startBatchJob(d.db, batchJobId);

  return { batchJobId, queuedCount, skippedImages };
}
