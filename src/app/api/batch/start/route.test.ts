/**
 * `POST /api/batch/start` (LH-042 / TRO-475) — HTTP-handler-level tests,
 * this repo's established convention (no live browser). Exercises the
 * connection this ticket closes: an accepted preview becomes a real,
 * running batch job.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../../../lib/db";
import { batchJobs, batchQueueItems, applications } from "../../../../lib/db/schema";
import { startBatchFromPairings } from "../../../../server/batch-start/start-batch";
import { saveLabelImage } from "../../../../server/storage/local-file-storage";
import { handleBatchStartRequest } from "./route";
import type { BatchStartErrorResponse, BatchStartSuccessResponse } from "./types";

const HEADER = "beverage_type,brand_name,class_type,alcohol_content_percent,net_contents_value,net_contents_unit,image_filename";

let scratchDir: string;
const createdBatchJobIds: number[] = [];

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro475-start-route-"));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
  for (const id of createdBatchJobIds.splice(0)) {
    await db.delete(batchJobs).where(eq(batchJobs.id, id));
  }
});

function testDeps() {
  return {
    startBatch: (pairings: Parameters<typeof startBatchFromPairings>[0]) =>
      startBatchFromPairings(pairings, { saveLabelImage: (bytes, name) => saveLabelImage(bytes, name, { baseDir: scratchDir }) }),
  };
}

async function realJpegBytes(width = 1200, height = 1600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
}

function csvFile(content: string, name = "manifest.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

async function imageFile(name: string): Promise<File> {
  const bytes = await realJpegBytes();
  // Type-only gap, not a behavioral one — same cast, same reasoning, as
  // `src/app/api/batch/preview/route.ts`'s own `readLimitedBody` comment:
  // this TypeScript/DOM-lib version's `BlobPart` does not structurally
  // accept a Node `Buffer` even though `new File(...)` accepts one at
  // runtime.
  return new File([bytes as unknown as BlobPart], name, { type: "image/jpeg" });
}

function requestWith(formData: FormData): Request {
  return new Request("http://localhost/api/batch/start", { method: "POST", body: formData });
}

async function trackAndCleanup(batchJobId: number) {
  createdBatchJobIds.push(batchJobId);
}

describe("handleBatchStartRequest", () => {
  it("starts a real, running batch from a clean multi-file-drop upload", async () => {
    const csvText = [
      HEADER,
      "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-01.jpg",
      "wine,Rolling Hills,Cabernet Sauvignon,13.5,750,mL,bottle-02.jpg",
    ].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.append("images", await imageFile("bottle-01.jpg"));
    fd.append("images", await imageFile("bottle-02.jpg"));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(200);
    const body = (await response.json()) as BatchStartSuccessResponse;
    await trackAndCleanup(body.batchJobId);

    expect(body.queuedCount).toBe(2);
    expect(body.skippedImages).toEqual([]);
    expect(body.unmatchedRows).toEqual([]);
    expect(body.unmatchedImages).toEqual([]);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, body.batchJobId));
    expect(job.status).toBe("RUNNING");
    expect(job.totalCount).toBe(2);

    const items = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, body.batchJobId));
    expect(items).toHaveLength(2);
  });

  it("starts a real batch from a clean zip upload — real bytes, not just metadata", async () => {
    const csvText = [HEADER, "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg"].join("\n");
    const zipped = zipSync({ "can-01.jpg": await realJpegBytes() });
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.set("imagesZip", new File([zipped], "images.zip", { type: "application/zip" }));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(200);
    const body = (await response.json()) as BatchStartSuccessResponse;
    await trackAndCleanup(body.batchJobId);

    expect(body.queuedCount).toBe(1);
    const apps = await db.select().from(applications).where(eq(applications.batchJobId, body.batchJobId));
    expect(apps).toHaveLength(1);
    expect(apps[0].brandName).toBe("Hopyard Co");
  });

  it("reports unmatched rows/images in the start response too, and still starts the ready rows", async () => {
    const csvText = [
      HEADER,
      "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-01.jpg",
      "beer,Hopyard Co,IPA,5,355,mL,missing.jpg",
    ].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.append("images", await imageFile("bottle-01.jpg"));
    fd.append("images", await imageFile("orphan.jpg"));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(200);
    const body = (await response.json()) as BatchStartSuccessResponse;
    await trackAndCleanup(body.batchJobId);

    expect(body.queuedCount).toBe(1);
    expect(body.unmatchedRows).toHaveLength(1);
    expect(body.unmatchedRows[0].rowNumber).toBe(3);
    expect(body.unmatchedImages).toHaveLength(1);
  });

  it("returns 422 NO_READY_ROWS and creates no batch when nothing matched", async () => {
    const csvText = [HEADER, "beer,Hopyard Co,IPA,5,355,mL,missing.jpg"].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.append("images", await imageFile("orphan.jpg"));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(422);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("NO_READY_ROWS");
  });

  it("returns 422 MALFORMED_CSV for a manifest missing a required column", async () => {
    const badCsv = "brand_name,class_type\nHopyard Co,IPA\n";
    const fd = new FormData();
    fd.set("manifest", csvFile(badCsv));
    fd.append("images", await imageFile("a.jpg"));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(422);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("MALFORMED_CSV");
  });

  it("returns 422 MALFORMED_ZIP for a corrupt zip upload", async () => {
    const csvText = [HEADER, "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg"].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.set("imagesZip", new File(["not actually a zip file"], "images.zip", { type: "application/zip" }));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(422);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("MALFORMED_ZIP");
  });

  it("returns 400 VALIDATION when no manifest file is present", async () => {
    const fd = new FormData();
    fd.append("images", await imageFile("a.jpg"));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
  });

  it("reports a skipped image (unreadable bytes) without failing the whole start, when at least one other pairing is readable", async () => {
    const csvText = [
      HEADER,
      "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,good.jpg",
      "spirits,Old Tom,Gin,40,750,mL,corrupt.jpg",
    ].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.append("images", await imageFile("good.jpg"));
    fd.append("images", new File(["not a real image"], "corrupt.jpg", { type: "image/jpeg" }));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(200);
    const body = (await response.json()) as BatchStartSuccessResponse;
    await trackAndCleanup(body.batchJobId);

    expect(body.queuedCount).toBe(1);
    expect(body.skippedImages).toHaveLength(1);
    expect(body.skippedImages[0].filename).toBe("corrupt.jpg");
  });

  it("never leaks a raw exception into the response body", async () => {
    const fd = new FormData();
    fd.set("manifest", "not-a-file");
    fd.append("images", await imageFile("a.jpg"));

    const response = await handleBatchStartRequest(requestWith(fd), testDeps());
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.message).not.toMatch(/Error:|at handleBatchStartRequest|\.ts:\d/);
  });

  it("rejects an oversized request from its Content-Length header alone", async () => {
    const request = new Request("http://localhost/api/batch/start", {
      method: "POST",
      headers: { "content-length": "3000000000" },
      body: "tiny-body-does-not-matter",
    });

    const response = await handleBatchStartRequest(request, testDeps());
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
    expect(body.error.message).toMatch(/too large/i);
  });
});
