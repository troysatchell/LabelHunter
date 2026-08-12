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
  it("enqueues one EXTRACT row per (application, image) pairing, and sets total_count to match", async () => {
    // totalCount: 0 — the real starting state a batch-creation caller
    // (LH-040) would use, before enqueueExtractItems has run at all.
    const batchJobId = await trackBatch({ totalCount: 0, status: "PENDING" });
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

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.totalCount).toBe(2);
  });

  it("is idempotent: re-enqueueing the SAME pairing (a retried upload handler) inserts nothing new, and does not double-count total_count", async () => {
    const batchJobId = await trackBatch({ totalCount: 0, status: "PENDING" });
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const pairs = [{ applicationId: a.applicationId, labelImageId: a.labelImageId }];

    const first = await enqueueExtractItems(db, batchJobId, pairs);
    expect(first).toBe(1);
    const second = await enqueueExtractItems(db, batchJobId, pairs);
    expect(second).toBe(0);

    const rows = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    expect(rows).toHaveLength(1);

    // The naive fix (total_count += pairings.length on every call) would
    // land on 2 here — wrong, since the retry inserted zero NEW rows.
    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.totalCount).toBe(1);
  });

  it("is idempotent under REAL concurrency too, not just sequential retries: two simultaneous callers enqueueing the same pairing insert exactly one row and total_count lands on exactly 1", async () => {
    const batchJobId = await trackBatch({ totalCount: 0, status: "PENDING" });
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const pairs = [{ applicationId: a.applicationId, labelImageId: a.labelImageId }];

    const [first, second] = await Promise.all([enqueueExtractItems(db, batchJobId, pairs), enqueueExtractItems(db, batchJobId, pairs)]);
    // Exactly one of the two concurrent callers wins the insert; the other
    // sees ON CONFLICT DO NOTHING and inserts zero rows — Postgres
    // serializes the two, the same way claim.test.ts's own concurrency
    // suite proves for the claim query.
    expect([first, second].sort()).toEqual([0, 1]);

    const rows = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    expect(rows).toHaveLength(1);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.totalCount).toBe(1);
  });

  it("enqueues only the genuinely new pairings in a partially-overlapping retry, and total_count reflects only the real total", async () => {
    const batchJobId = await trackBatch({ totalCount: 0, status: "PENDING" });
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

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.totalCount).toBe(2);
  });

  it("rejects enqueueing into a batch that is not PENDING (RUNNING, already started) — a caller bug, not a silent no-op", async () => {
    const batchJobId = await trackBatch({ totalCount: 0, status: "RUNNING" });
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");

    await expect(enqueueExtractItems(db, batchJobId, [{ applicationId: a.applicationId, labelImageId: a.labelImageId }])).rejects.toThrow(/not PENDING/);

    // The rejection happens before either write — nothing inserted, and
    // total_count is untouched, not a partial write left half-committed.
    const rows = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    expect(rows).toHaveLength(0);
    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.totalCount).toBe(0);
  });

  it("rejects enqueueing into a COMPLETED batch the same way", async () => {
    const batchJobId = await trackBatch({ totalCount: 0, status: "COMPLETED" });
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");

    await expect(enqueueExtractItems(db, batchJobId, [{ applicationId: a.applicationId, labelImageId: a.labelImageId }])).rejects.toThrow(/not PENDING/);
  });
});
