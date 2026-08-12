/**
 * `startBatchFromPairings` against a real Postgres database (LH-042 /
 * TRO-475) — the connection LH-040/LH-041 left open (see this file's
 * sibling `start-batch.ts`'s own header comment).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { applications, batchJobs, batchQueueItems, labelImages } from "../../lib/db/schema";
import type { ManifestRow } from "../batch/types";
import { readLabelImage, saveLabelImage } from "../storage/local-file-storage";
import { startBatchFromPairings } from "./start-batch";
import type { StartBatchPairingInput } from "./types";

let scratchDir: string;
const createdBatchJobIds: number[] = [];

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro475-start-batch-"));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
  for (const id of createdBatchJobIds.splice(0)) {
    await db.delete(batchJobs).where(eq(batchJobs.id, id));
  }
});

async function realJpeg(width = 1200, height = 1600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
}

function makeRow(overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    rowNumber: 2,
    beverageType: "spirits",
    brandName: "TRO-475 Test Brand",
    classType: "Straight Bourbon Whiskey",
    alcoholContentPercent: 45,
    netContentsValue: 750,
    netContentsUnit: "mL",
    imageFilename: "bottle-01.jpg",
    ...overrides,
  };
}

function deps() {
  return {
    saveLabelImage: (bytes: Buffer, filename: string) => saveLabelImage(bytes, filename, { baseDir: scratchDir }),
  };
}

describe("startBatchFromPairings", () => {
  it("creates a RUNNING batch with one queued EXTRACT item per readable pairing", async () => {
    const bytes = await realJpeg();
    const pairings: StartBatchPairingInput[] = [
      { row: makeRow({ rowNumber: 2, imageFilename: "a.jpg", brandName: "Highland Peak" }), filename: "a.jpg", bytes },
      { row: makeRow({ rowNumber: 3, imageFilename: "b.jpg", brandName: "Rolling Hills" }), filename: "b.jpg", bytes },
    ];

    const result = await startBatchFromPairings(pairings, deps());
    createdBatchJobIds.push(result.batchJobId);

    expect(result.queuedCount).toBe(2);
    expect(result.skippedImages).toEqual([]);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, result.batchJobId));
    expect(job.status).toBe("RUNNING");
    expect(job.totalCount).toBe(2);
    expect(job.startedAt).not.toBeNull();

    const apps = await db.select().from(applications).where(eq(applications.batchJobId, result.batchJobId));
    expect(apps).toHaveLength(2);
    expect(apps.map((a) => a.brandName).sort()).toEqual(["Highland Peak", "Rolling Hills"]);

    const items = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, result.batchJobId));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "EXTRACT" && i.status === "PENDING")).toBe(true);
  });

  it("populates the applications row's raw/parsed fields from the manifest row, mirroring the single-verify insert shape", async () => {
    const bytes = await realJpeg();
    const row = makeRow({ alcoholContentPercent: 13.5, netContentsValue: 750, netContentsUnit: "mL", brandName: "Rolling Hills", classType: "Cabernet Sauvignon" });
    const result = await startBatchFromPairings([{ row, filename: "a.jpg", bytes }], deps());
    createdBatchJobIds.push(result.batchJobId);

    const [app] = await db.select().from(applications).where(eq(applications.batchJobId, result.batchJobId));
    expect(app.brandName).toBe("Rolling Hills");
    expect(app.classType).toBe("Cabernet Sauvignon");
    expect(app.abvPercent).toBe(13.5);
    expect(app.alcoholContentRaw).toBe("13.5%");
    expect(app.netContentsValue).toBe(750);
    expect(app.netContentsUnit).toBe("mL");
    expect(app.netContentsRaw).toBe("750 mL");
  });

  it("stores the real image bytes and the EXIF-corrected dimensions on the label_images row", async () => {
    const bytes = await realJpeg(1200, 1600);
    const result = await startBatchFromPairings([{ row: makeRow(), filename: "a.jpg", bytes }], deps());
    createdBatchJobIds.push(result.batchJobId);

    const [image] = await db.select().from(labelImages).where(eq(labelImages.batchJobId, result.batchJobId));
    expect(image.originalFilename).toBe("a.jpg");
    expect(image.widthPx).toBe(1200);
    expect(image.heightPx).toBe(1600);

    const onDisk = await readLabelImage(image.storagePath, { baseDir: scratchDir });
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it("leaves alcoholContentPercent null (legal for beer/wine) as a null abvPercent, not a fabricated 0", async () => {
    const bytes = await realJpeg();
    const row = makeRow({ beverageType: "beer", alcoholContentPercent: null });
    const result = await startBatchFromPairings([{ row, filename: "a.jpg", bytes }], deps());
    createdBatchJobIds.push(result.batchJobId);

    const [app] = await db.select().from(applications).where(eq(applications.batchJobId, result.batchJobId));
    expect(app.abvPercent).toBeNull();
    expect(app.alcoholContentRaw).toBeNull();
  });

  it("skips a pairing whose image bytes cannot be decoded, reports it, and still queues the other readable pairings (PRD §3.5: one bad image fails only that item)", async () => {
    const goodBytes = await realJpeg();
    const corruptBytes = Buffer.from("this is not a real image file at all");
    const pairings: StartBatchPairingInput[] = [
      { row: makeRow({ rowNumber: 2, imageFilename: "good.jpg" }), filename: "good.jpg", bytes: goodBytes },
      { row: makeRow({ rowNumber: 3, imageFilename: "corrupt.jpg" }), filename: "corrupt.jpg", bytes: corruptBytes },
    ];

    const result = await startBatchFromPairings(pairings, deps());
    createdBatchJobIds.push(result.batchJobId);

    expect(result.queuedCount).toBe(1);
    expect(result.skippedImages).toHaveLength(1);
    expect(result.skippedImages[0]).toMatchObject({ filename: "corrupt.jpg", rowNumber: 3 });
    // Plain English (TH-R20) — the preprocessing error's own designed
    // message, never a raw exception.
    expect(result.skippedImages[0].reason).not.toMatch(/Error:|at startBatchFromPairings|\.ts:\d/);

    const apps = await db.select().from(applications).where(eq(applications.batchJobId, result.batchJobId));
    expect(apps).toHaveLength(1);
    expect(apps[0].brandName).toBe("TRO-475 Test Brand");

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, result.batchJobId));
    expect(job.status).toBe("RUNNING");
    expect(job.totalCount).toBe(1);
  });

  it("marks the batch FAILED, never a phantom empty RUNNING batch, when every pairing's image is unreadable", async () => {
    const corruptBytes = Buffer.from("also not a real image");
    const pairings: StartBatchPairingInput[] = [{ row: makeRow(), filename: "corrupt.jpg", bytes: corruptBytes }];

    const result = await startBatchFromPairings(pairings, deps());
    createdBatchJobIds.push(result.batchJobId);

    expect(result.queuedCount).toBe(0);
    expect(result.skippedImages).toHaveLength(1);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, result.batchJobId));
    expect(job.status).toBe("FAILED");
    expect(job.totalCount).toBe(0);

    const items = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, result.batchJobId));
    expect(items).toHaveLength(0);
  });

  it("reports a skipped image with a plain-English reason when saving the file itself fails, instead of throwing", async () => {
    const bytes = await realJpeg();
    const failingSave = async (): Promise<never> => {
      throw new Error("disk full (simulated)");
    };
    const result = await startBatchFromPairings([{ row: makeRow(), filename: "a.jpg", bytes }], { saveLabelImage: failingSave });
    createdBatchJobIds.push(result.batchJobId);

    expect(result.queuedCount).toBe(0);
    expect(result.skippedImages).toHaveLength(1);
    expect(result.skippedImages[0].reason).not.toMatch(/disk full|Error:/);
  });
});
