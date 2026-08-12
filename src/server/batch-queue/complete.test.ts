/**
 * `complete.ts` against a real Postgres database (LH-041 / TRO-474, CP-3
 * §3.2, §7.2). The completion guard is the second half of the atomic-claim
 * design: §3.1's claim stops two workers from STARTING the same item;
 * this stops a worker whose lease already expired from FINISHING it after
 * someone else already has.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { batchJobs, batchQueueItems } from "../../lib/db/schema";
import { claimNextBatchQueueItem } from "./claim";
import { markDone, markFailed, maybeCompleteBatchJob, releaseForRetry } from "./complete";
import { cleanupBatchJobFixture, createApplicationAndImageFixture, createBatchJobFixture, enqueueExtractItemFixture } from "./test-support";

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

async function claimedFixture(batchJobId: number, filename = "a.jpg") {
  const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, filename);
  await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });
  const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
  if (!claimed) throw new Error("test setup failed: claim returned null");
  return claimed;
}

describe("markDone", () => {
  it("completes a row this worker still holds the lease for", async () => {
    const batchJobId = await trackBatch();
    const claimed = await claimedFixture(batchJobId);

    const guarded = await markDone(db, claimed.id, claimed.claimToken as string);
    expect(guarded).toBe(true);

    const [row] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(row.status).toBe("DONE");
  });

  it("REFUSES to complete using a stale claim_token — the lost-lease race (CP-3 §3.2)", async () => {
    const batchJobId = await trackBatch();
    const staleClaim = await claimedFixture(batchJobId);

    // Simulate the lease expiring, and a second worker reclaiming the row —
    // without a real sleep (lessons.md #8).
    await db.update(batchQueueItems).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(batchQueueItems.id, staleClaim.id));
    const freshClaim = await claimNextBatchQueueItem(db, "EXTRACT", "worker-2", 60, { scopeToBatchJobId: batchJobId });
    expect(freshClaim?.id).toBe(staleClaim.id);
    expect(freshClaim?.claimToken).not.toBe(staleClaim.claimToken);

    // The FIRST (stale) worker's completion attempt must affect zero rows —
    // its own claim episode is no longer the current one.
    const staleGuarded = await markDone(db, staleClaim.id, staleClaim.claimToken as string);
    expect(staleGuarded).toBe(false);

    // The row must be untouched by the stale attempt: still CLAIMED, still
    // owned by the fresh worker's token, not DONE.
    const [row] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, staleClaim.id));
    expect(row.status).toBe("CLAIMED");
    expect(row.claimToken).toBe(freshClaim?.claimToken);

    // The second (current) worker's completion must still succeed normally.
    const freshGuarded = await markDone(db, freshClaim!.id, freshClaim!.claimToken as string);
    expect(freshGuarded).toBe(true);
    const [finalRow] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, staleClaim.id));
    expect(finalRow.status).toBe("DONE");
  });

  it("returns false for a non-existent item id", async () => {
    const guarded = await markDone(db, 999_999_999, "00000000-0000-0000-0000-000000000000");
    expect(guarded).toBe(false);
  });

  it("returns false when the row is no longer CLAIMED (already DONE)", async () => {
    const batchJobId = await trackBatch();
    const claimed = await claimedFixture(batchJobId);
    expect(await markDone(db, claimed.id, claimed.claimToken as string)).toBe(true);
    // A second completion attempt with the SAME token must not re-match —
    // status is no longer CLAIMED.
    expect(await markDone(db, claimed.id, claimed.claimToken as string)).toBe(false);
  });
});

describe("releaseForRetry", () => {
  it("releases a claimed row back to PENDING, clears claim fields, and pushes availableAt forward", async () => {
    const batchJobId = await trackBatch();
    const claimed = await claimedFixture(batchJobId);
    const before = Date.now();

    const guarded = await releaseForRetry(db, claimed.id, claimed.claimToken as string, 5000);
    expect(guarded).toBe(true);

    const [row] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(row.status).toBe("PENDING");
    expect(row.claimedBy).toBeNull();
    expect(row.claimToken).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(before + 4000); // allow scheduling slack
  });

  it("does not release using a stale claim_token", async () => {
    const batchJobId = await trackBatch();
    const claimed = await claimedFixture(batchJobId);
    await db.update(batchQueueItems).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(batchQueueItems.id, claimed.id));
    const reclaimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-2", 60, { scopeToBatchJobId: batchJobId });

    const staleGuarded = await releaseForRetry(db, claimed.id, claimed.claimToken as string, 5000);
    expect(staleGuarded).toBe(false);

    const [row] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(row.status).toBe("CLAIMED");
    expect(row.claimToken).toBe(reclaimed?.claimToken);
  });

  it("attempts is left untouched by a release — only the claim query increments it", async () => {
    const batchJobId = await trackBatch();
    const claimed = await claimedFixture(batchJobId);
    expect(claimed.attempts).toBe(1);
    await releaseForRetry(db, claimed.id, claimed.claimToken as string, 1000);
    const [row] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(row.attempts).toBe(1);
  });
});

describe("markFailed", () => {
  it("marks a row FAILED with the given last_error, and clears claim fields", async () => {
    const batchJobId = await trackBatch();
    const claimed = await claimedFixture(batchJobId);

    const guarded = await markFailed(db, claimed.id, claimed.claimToken as string, "corrupt image: VipsJpeg decode failed");
    expect(guarded).toBe(true);

    const [row] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBe("corrupt image: VipsJpeg decode failed");
    expect(row.claimedBy).toBeNull();
    expect(row.claimToken).toBeNull();
  });

  it("does not fail using a stale claim_token", async () => {
    const batchJobId = await trackBatch();
    const claimed = await claimedFixture(batchJobId);
    await db.update(batchQueueItems).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(batchQueueItems.id, claimed.id));
    await claimNextBatchQueueItem(db, "EXTRACT", "worker-2", 60, { scopeToBatchJobId: batchJobId });

    const staleGuarded = await markFailed(db, claimed.id, claimed.claimToken as string, "should not apply");
    expect(staleGuarded).toBe(false);
    const [row] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(row.lastError).not.toBe("should not apply");
  });
});

describe("maybeCompleteBatchJob (CP-3 §7.2)", () => {
  it("flips RUNNING to COMPLETED once every queue item is terminal, regardless of failures", async () => {
    const batchJobId = await trackBatch({ totalCount: 2 });
    const claimedOk = await claimedFixture(batchJobId, "ok.jpg");
    const claimedBad = await claimedFixture(batchJobId, "bad.jpg");
    await markDone(db, claimedOk.id, claimedOk.claimToken as string);
    await markFailed(db, claimedBad.id, claimedBad.claimToken as string, "unreadable image");

    const completed = await maybeCompleteBatchJob(db, batchJobId);
    expect(completed).toBe(true);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.status).toBe("COMPLETED");
    expect(job.completedAt).not.toBeNull();
  });

  it("does NOT complete while any item is still PENDING or CLAIMED", async () => {
    const batchJobId = await trackBatch({ totalCount: 2 });
    const claimedOk = await claimedFixture(batchJobId, "ok.jpg");
    await markDone(db, claimedOk.id, claimedOk.claimToken as string);
    // Second item stays PENDING (never claimed/completed).
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "pending.jpg");
    await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    const completed = await maybeCompleteBatchJob(db, batchJobId);
    expect(completed).toBe(false);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.status).toBe("RUNNING");
  });

  it("is a no-op on a batch that is not currently RUNNING", async () => {
    const batchJobId = await trackBatch({ status: "PENDING", totalCount: 0 });
    const completed = await maybeCompleteBatchJob(db, batchJobId);
    expect(completed).toBe(false);
    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.status).toBe("PENDING");
  });

  it("two concurrent callers both checking completion at once flip status exactly once (no crash, no double-complete)", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId);
    await markDone(db, claimed.id, claimed.claimToken as string);

    const [a, b] = await Promise.all([maybeCompleteBatchJob(db, batchJobId), maybeCompleteBatchJob(db, batchJobId)]);
    // Exactly one caller should observe the transition it caused; Postgres's
    // row lock serializes the two UPDATEs, so this can never be [true, true].
    expect([a, b].filter(Boolean)).toHaveLength(1);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.status).toBe("COMPLETED");
  });
});
