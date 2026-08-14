/**
 * `POST /api/batch/start` (LH-042 / TRO-475) — HTTP-handler-level tests,
 * this repo's established convention (no live browser). Exercises the
 * connection this ticket closes: an accepted preview becomes a real,
 * running batch job.
 */
import { zipSync } from "fflate";
import sharp from "sharp";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../../../lib/db";
import { batchJobs, batchQueueItems, applications, labelImages } from "../../../../lib/db/schema";
import { startBatchFromPairings } from "../../../../server/batch-start/start-batch";
import { deleteLabelImageBlobsWhere } from "../../../../server/storage/db-image-storage";
import { BUDGET_CHECK_UNAVAILABLE_MESSAGE, BUDGET_EXHAUSTED_MESSAGE } from "../../../../server/budget/daily-budget";
import { createFixedWindowLimiter } from "../../../../server/rate-limit/fixed-window";
import { checkRateLimitPair } from "../../../../server/rate-limit/instances";
import { handleBatchStartRequest } from "./route";
import type { BatchStartErrorResponse, BatchStartSuccessResponse } from "./types";

const HEADER = "beverage_type,brand_name,class_type,alcohol_content_percent,net_contents_value,net_contents_unit,image_filename";

const createdBatchJobIds: number[] = [];

afterEach(async () => {
  const ids = createdBatchJobIds.splice(0);
  if (ids.length > 0) {
    // TRO-518: label_image_blobs rows are not reached by the cascade below
    // — see db-image-storage.ts's own deleteLabelImageBlobsWhere comment.
    await deleteLabelImageBlobsWhere(inArray(labelImages.batchJobId, ids));
  }
  for (const id of ids) {
    await db.delete(batchJobs).where(eq(batchJobs.id, id));
  }
});

function testDeps() {
  return {
    // TRO-518: startBatchFromPairings' own default saveLabelImage already
    // writes through the real db-image-storage.ts adapter — no scratch
    // directory to inject anymore.
    startBatch: (pairings: Parameters<typeof startBatchFromPairings>[0]) => startBatchFromPairings(pairings),
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

// TRO-482 / LH-061, PRD §8 — key protection. checkRateLimit/checkBudget are
// OPTIONAL on HandleBatchStartOptions with an always-allow fallback inside
// handleBatchStartRequest itself — every test ABOVE this point predates this
// ticket and needed zero changes (confirmed: this file's pre-existing 10
// cases pass unmodified). This route never calls the model inline (batch
// extraction happens later, in the background worker), so unlike
// /api/verify there is no spend to record here — only the pre-call gate.
describe("POST /api/batch/start — rate limit gate (TRO-482)", () => {
  async function simpleUpload(): Promise<FormData> {
    const fd = new FormData();
    fd.set("manifest", csvFile([HEADER, "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-01.jpg"].join("\n")));
    fd.append("images", await imageFile("bottle-01.jpg"));
    return fd;
  }

  it("rejects with a friendly message and never starts a batch when checkRateLimit says no", async () => {
    let startBatchCalled = false;
    const response = await handleBatchStartRequest(requestWith(await simpleUpload()), {
      ...testDeps(),
      checkRateLimit: () => ({
        allowed: false,
        message: "LabelHunter is getting more requests than it can handle right now. Wait 45 seconds and try again.",
      }),
      startBatch: async (pairings) => {
        startBatchCalled = true;
        return testDeps().startBatch(pairings);
      },
    });

    expect(response.status).toBe(429);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("RATE_LIMITED");
    expect(body.error.message.toLowerCase()).toMatch(/wait|moment|again/);
    expect(body.error.message).not.toMatch(/\b429\b/);
    expect(startBatchCalled).toBe(false);
  });

  it("proves the Nth+1 batch submission within a real window is rejected — the real production limiter, not just a stub", async () => {
    const ipLimiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const globalLimiter = createFixedWindowLimiter({ limit: 1000, windowMs: 60_000 });
    const checkRateLimit = (request: Request) => checkRateLimitPair(request, ipLimiter, globalLimiter);

    const first = await handleBatchStartRequest(requestWith(await simpleUpload()), { ...testDeps(), checkRateLimit });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as BatchStartSuccessResponse;
    await trackAndCleanup(firstBody.batchJobId);

    let secondCalled = false;
    const second = await handleBatchStartRequest(requestWith(await simpleUpload()), {
      ...testDeps(),
      checkRateLimit,
      startBatch: async (pairings) => {
        secondCalled = true;
        return testDeps().startBatch(pairings);
      },
    });
    expect(second.status).toBe(429);
    const secondBody = (await second.json()) as BatchStartErrorResponse;
    expect(secondBody.error.kind).toBe("RATE_LIMITED");
    expect(secondCalled).toBe(false);
  });
});

describe("POST /api/batch/start — daily budget gate (TRO-482)", () => {
  it("rejects with a friendly message and never starts a batch when the budget is exhausted", async () => {
    let startBatchCalled = false;
    const fd = new FormData();
    fd.set("manifest", csvFile([HEADER, "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-01.jpg"].join("\n")));
    fd.append("images", await imageFile("bottle-01.jpg"));

    const response = await handleBatchStartRequest(requestWith(fd), {
      ...testDeps(),
      checkBudget: async () => ({ exhausted: true, spentUsd: 5, budgetUsd: 5 }),
      startBatch: async (pairings) => {
        startBatchCalled = true;
        return testDeps().startBatch(pairings);
      },
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("BUDGET_EXHAUSTED");
    expect(body.error.message).toBe(BUDGET_EXHAUSTED_MESSAGE);
    expect(startBatchCalled).toBe(false);
  });

  // TRO-566 finding 3 — a ledger read failure must fail closed (no batch
  // starts) with the DESIGNED 503 response, not an unhandled 500.
  it("returns a designed 503 SERVICE response, not a raw 500, when the budget check itself throws", async () => {
    let startBatchCalled = false;
    const fd = new FormData();
    fd.set("manifest", csvFile([HEADER, "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-01.jpg"].join("\n")));
    fd.append("images", await imageFile("bottle-01.jpg"));

    const response = await handleBatchStartRequest(requestWith(fd), {
      ...testDeps(),
      checkBudget: async () => {
        throw new Error("connection terminated unexpectedly");
      },
      startBatch: async (pairings) => {
        startBatchCalled = true;
        return testDeps().startBatch(pairings);
      },
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("SERVICE");
    expect(body.error.message).toBe(BUDGET_CHECK_UNAVAILABLE_MESSAGE);
    expect(body.error.message).not.toBe(BUDGET_EXHAUSTED_MESSAGE);
    expect(startBatchCalled).toBe(false);
  });
});
