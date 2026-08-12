/**
 * `GET /api/batch/:batchJobId` (LH-042 / TRO-475) — HTTP-handler-level
 * tests, this repo's established convention (no live browser).
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../../../lib/db";
import { verifications } from "../../../../lib/db/schema";
import { cleanupBatchJobFixture, createApplicationAndImageFixture, createBatchJobFixture } from "../../../../server/batch-queue/test-support";
import { handleBatchProgressRequest } from "./route";
import type { BatchProgressErrorResponse, BatchProgressResponse } from "./types";

const createdBatchJobIds: number[] = [];

afterEach(async () => {
  for (const id of createdBatchJobIds.splice(0)) {
    await cleanupBatchJobFixture(db, id);
  }
});

async function trackBatch(overrides?: Parameters<typeof createBatchJobFixture>[1]): Promise<number> {
  const id = await createBatchJobFixture(db, overrides);
  createdBatchJobIds.push(id);
  return id;
}

describe("handleBatchProgressRequest", () => {
  it("returns 200 with the live summary and results for a real batch", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const a = await createApplicationAndImageFixture(db, batchJobId, "bottle-01.jpg");
    await db.insert(verifications).values({ applicationId: a.applicationId, labelImageId: a.labelImageId, batchJobId, verdict: "PASS", resolutionPath: "EXTRACTOR_ONLY" });

    const response = await handleBatchProgressRequest(String(batchJobId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as BatchProgressResponse;
    expect(body.batchJobId).toBe(batchJobId);
    expect(body.totalCount).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].label).toBe("bottle-01.jpg");
    expect(typeof body.results[0].verificationId).toBe("number");
  });

  it("serializes startedAt/completedAt as ISO-8601 strings, not Date objects", async () => {
    const batchJobId = await trackBatch();
    const response = await handleBatchProgressRequest(String(batchJobId));
    const body = (await response.json()) as BatchProgressResponse;
    expect(typeof body.startedAt).toBe("string");
    expect(new Date(body.startedAt as string).toISOString()).toBe(body.startedAt);
    expect(body.completedAt).toBeNull();
  });

  it("returns latency: null (not a fabricated number) when nothing has finished yet", async () => {
    const batchJobId = await trackBatch();
    const response = await handleBatchProgressRequest(String(batchJobId));
    const body = (await response.json()) as BatchProgressResponse;
    expect(body.latency).toBeNull();
  });

  it("returns 404 NOT_FOUND for a batch job id that does not exist", async () => {
    const response = await handleBatchProgressRequest("999999999");
    expect(response.status).toBe(404);
    const body = (await response.json()) as BatchProgressErrorResponse;
    expect(body.error.kind).toBe("NOT_FOUND");
  });

  it("returns 400 VALIDATION for a non-numeric id, never a raw exception", async () => {
    const response = await handleBatchProgressRequest("not-a-number");
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchProgressErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION for a negative or zero id", async () => {
    const negative = await handleBatchProgressRequest("-4");
    expect(negative.status).toBe(400);
    const zero = await handleBatchProgressRequest("0");
    expect(zero.status).toBe(400);
  });

  it("returns 400 VALIDATION for an id string a bare Number() would silently coerce (e.g. hex or exponent notation)", async () => {
    const hex = await handleBatchProgressRequest("0x10");
    expect(hex.status).toBe(400);
    const exponent = await handleBatchProgressRequest("1e2");
    expect(exponent.status).toBe(400);
  });

  it("returns 503 SERVICE, not a raw exception, when the read itself throws", async () => {
    const failingDb = { select: () => { throw new Error("db exploded"); } } as unknown as typeof db;
    const response = await handleBatchProgressRequest("1", { db: failingDb });
    expect(response.status).toBe(503);
    const body = (await response.json()) as BatchProgressErrorResponse;
    expect(body.error.kind).toBe("SERVICE");
    expect(body.error.message).not.toMatch(/db exploded|Error:/);
  });

  it("never puts a bare confidence number or a raw model identifier in a row's rendered status text (standing rule 12 / TH-R20)", async () => {
    // `resolvedBySonnetCount` (a wire field NAME mirroring the PRD's own
    // "resolved-by-Sonnet" category and the batch_jobs column of the same
    // name) is not the concern here — DetailView.tsx already shows
    // "Resolved by Sonnet" as an intentional, PRD-mandated annotation (PRD
    // §5). The rule is about the RENDERED prose a reader sees carrying a
    // bare confidence number or a raw model slug with no plain-English
    // framing — checked against `statusText` itself, not every wire key.
    const batchJobId = await trackBatch();
    const a = await createApplicationAndImageFixture(db, batchJobId, "bottle-01.jpg");
    await db.insert(verifications).values({ applicationId: a.applicationId, labelImageId: a.labelImageId, batchJobId, verdict: "REVIEW", resolutionPath: "EXTRACTOR_ONLY" });

    const response = await handleBatchProgressRequest(String(batchJobId));
    const body = (await response.json()) as BatchProgressResponse;
    for (const row of body.results) {
      expect(row.statusText).not.toMatch(/claude-(haiku|sonnet)|^\d+(\.\d+)?%?$/i);
    }
  });
});

// Sanity: the fixture cleanup path itself also removes the verification
// rows inserted above (ON DELETE CASCADE from batch_jobs) — asserted here
// once so every test above can stay focused on its own behavior.
describe("fixture cleanup", () => {
  it("cascades from batch_jobs to verifications", async () => {
    const batchJobId = await createBatchJobFixture(db);
    const a = await createApplicationAndImageFixture(db, batchJobId, "x.jpg");
    const [v] = await db
      .insert(verifications)
      .values({ applicationId: a.applicationId, labelImageId: a.labelImageId, batchJobId, verdict: "PASS", resolutionPath: "EXTRACTOR_ONLY" })
      .returning();
    await cleanupBatchJobFixture(db, batchJobId);
    const remaining = await db.select().from(verifications).where(eq(verifications.id, v.id));
    expect(remaining).toHaveLength(0);
  });
});
