/**
 * `lifecycle.ts` against a real Postgres database (LH-041 / TRO-474, CP-3
 * §2.2, §8 steps 1–2). LH-040 (not yet built) is the real caller of
 * `enqueueExtractItems` at upload time; these tests exercise the same
 * contract directly.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { batchJobs, batchQueueItems } from "../../lib/db/schema";
import { enqueueExtractItems, startBatchJob } from "./lifecycle";
import { cleanupBatchJobFixture, createApplicationAndImageFixture, createBatchJobFixture } from "./test-support";

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

describe("startBatchJob", () => {
  it("flips PENDING to RUNNING and sets startedAt", async () => {
    const batchJobId = await trackBatch({ status: "PENDING" });
    const started = await startBatchJob(db, batchJobId);
    expect(started).toBe(true);
    const [row] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(row.status).toBe("RUNNING");
    expect(row.startedAt).not.toBeNull();
  });

  it("is a no-op on a batch that is not PENDING", async () => {
    const batchJobId = await trackBatch({ status: "RUNNING" });
    const started = await startBatchJob(db, batchJobId);
    expect(started).toBe(false);
  });
});

describe("enqueueExtractItems (CP-3 §2.2 — idempotent enqueue)", () => {
  it("enqueues one EXTRACT row per (application, image) pairing", async () => {
    const batchJobId = await trackBatch();
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const b = await createApplicationAndImageFixture(db, batchJobId, "b.jpg");

    const inserted = await enqueueExtractItems(db, batchJobId, [
      { applicationId: a.applicationId, labelImageId: a.labelImageId },
      { applicationId: b.applicationId, labelImageId: b.labelImageId },
    ]);
    expect(inserted).toBe(2);

    const rows = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "EXTRACT" && r.status === "PENDING")).toBe(true);
  });

  it("is idempotent: re-enqueueing the SAME pairing (a retried upload handler) inserts nothing new", async () => {
    const batchJobId = await trackBatch();
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const pairs = [{ applicationId: a.applicationId, labelImageId: a.labelImageId }];

    const first = await enqueueExtractItems(db, batchJobId, pairs);
    expect(first).toBe(1);
    const second = await enqueueExtractItems(db, batchJobId, pairs);
    expect(second).toBe(0);

    const rows = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    expect(rows).toHaveLength(1);
  });

  it("enqueues only the genuinely new pairings in a partially-overlapping retry", async () => {
    const batchJobId = await trackBatch();
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const b = await createApplicationAndImageFixture(db, batchJobId, "b.jpg");

    await enqueueExtractItems(db, batchJobId, [{ applicationId: a.applicationId, labelImageId: a.labelImageId }]);
    const second = await enqueueExtractItems(db, batchJobId, [
      { applicationId: a.applicationId, labelImageId: a.labelImageId }, // already enqueued
      { applicationId: b.applicationId, labelImageId: b.labelImageId }, // new
    ]);
    expect(second).toBe(1);

    const rows = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    expect(rows).toHaveLength(2);
  });
});
