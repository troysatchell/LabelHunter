/**
 * Turns an accepted batch preview's matched pairings into a real, running
 * batch job (LH-042 / TRO-475).
 *
 * **This connection did not exist before this ticket.** `buildBatchPreview`
 * (`../batch/index.ts`) explicitly never writes to the database or enqueues
 * anything — its own file comment names LH-041/LH-042 as the tickets that
 * do. LH-041 built the queue and worker pool, but its own worker entry
 * point says the same thing from the other side: `scripts/batch-worker/run.ts`'s
 * file comment states plainly that it "does not... flip a batch to RUNNING
 * — `lifecycle.ts`'s `startBatchJob` is the hook a future batch-creation
 * caller (LH-040/LH-042) uses for that." This module is that caller.
 *
 * Mirrors `src/app/api/verify/route.ts`'s single-label shape, run once per
 * matched pairing: preprocess the image (EXIF-correct, validate, decode),
 * save the original to disk, insert `applications` + `label_images`. Once
 * every pairing has been through that, the whole set is handed to LH-041's
 * own, already-tested `enqueueExtractItems` + `startBatchJob`
 * (`../batch-queue`) — this module owns none of that queue logic itself,
 * matching this ticket's own scope rule (never touch `../batch-queue`'s
 * core claim/complete/pool logic).
 *
 * **One bad image fails only that pairing, never the whole batch start**
 * (PRD §3.5: "one bad image fails that item, never the job" — the same rule
 * applies here as it does to an already-running batch). A pairing whose
 * image cannot be decoded or saved is reported back in `skippedImages`,
 * never silently dropped (TH-R20), and simply never becomes a queued label.
 * If EVERY pairing fails this way, the batch is marked `FAILED` rather than
 * left `RUNNING` with `totalCount = 0` forever — an empty running batch
 * would never reach `COMPLETED`, since nothing would ever call
 * `maybeCompleteBatchJob` for it.
 *
 * Deliberately sequential, not concurrent, unlike the worker pool's own
 * claim loop. PRD §3.5's "never serial" rule ("never `for image: await
 * extract(image)` serially") targets EXTRACTION throughput once a batch is
 * running — this is a one-time ingestion step, and batch mode is
 * throughput-bound, not latency-bound, for the run itself (PRD §3.8). Not
 * measured against a real multi-hundred-image upload; a future ticket can
 * parallelize this with bounded concurrency if that turns out to matter.
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
