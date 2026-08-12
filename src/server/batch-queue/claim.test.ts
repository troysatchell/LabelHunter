/**
 * `claimNextBatchQueueItem` against a real Postgres database (LH-041 /
 * TRO-474, CP-3 §3.1/§3.2). No mocking — the whole point of this suite is
 * proving `FOR UPDATE SKIP LOCKED` actually prevents two workers from
 * claiming the same row, which only a real database can prove.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { batchQueueItems } from "../../lib/db/schema";
import { claimNextBatchQueueItem } from "./claim";
import {
  cleanupBatchJobFixture,
  createApplicationAndImageFixture,
  createBatchJobFixture,
  createVerificationFixture,
  dbPastTimestamp,
  enqueueExtractItemFixture,
  enqueueResolveItemFixture,
} from "./test-support";

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

describe("claimNextBatchQueueItem — happy path", () => {
  it("claims a PENDING item: sets CLAIMED, a fresh claim_token, claimedBy, a future lease, and increments attempts", async () => {
    const batchJobId = await trackBatch();
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const itemId = await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    const before = Date.now();
    const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });

    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(itemId);
    expect(claimed?.status).toBe("CLAIMED");
    expect(claimed?.claimedBy).toBe("worker-1");
    expect(claimed?.claimToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseExpiresAt?.getTime()).toBeGreaterThan(before);
    expect(claimed?.applicationId).toBe(applicationId);
    expect(claimed?.labelImageId).toBe(labelImageId);
  });

  it("returns null when no item is available for that kind", async () => {
    const batchJobId = await trackBatch();
    const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(claimed).toBeNull();
  });

  it("never claims from a batch that has not started (status PENDING)", async () => {
    const batchJobId = await trackBatch({ status: "PENDING" });
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(claimed).toBeNull();
  });

  it("never claims from a batch that has completed or failed", async () => {
    const batchJobId = await trackBatch({ status: "COMPLETED" });
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(claimed).toBeNull();
  });

  it("filters strictly by kind — an EXTRACT claim never returns a RESOLVE row", async () => {
    const batchJobId = await trackBatch();
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId, batchJobId);
    await enqueueResolveItemFixture(db, { batchJobId, verificationId });

    const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(claimed).toBeNull();

    const resolveClaimed = await claimNextBatchQueueItem(db, "RESOLVE", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(resolveClaimed?.kind).toBe("RESOLVE");
    expect(resolveClaimed?.verificationId).toBe(verificationId);
  });

  it("does not claim a row whose availableAt is in the future", async () => {
    const batchJobId = await trackBatch();
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    await enqueueExtractItemFixture(
      db,
      { batchJobId, applicationId, labelImageId },
      { availableAt: new Date(Date.now() + 60_000) },
    );

    const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(claimed).toBeNull();
  });

  it("claims the lowest id first when multiple items are available", async () => {
    const batchJobId = await trackBatch();
    const { applicationId: a1, labelImageId: l1 } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const { applicationId: a2, labelImageId: l2 } = await createApplicationAndImageFixture(db, batchJobId, "b.jpg");
    const first = await enqueueExtractItemFixture(db, { batchJobId, applicationId: a1, labelImageId: l1 });
    await enqueueExtractItemFixture(db, { batchJobId, applicationId: a2, labelImageId: l2 });

    const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(claimed?.id).toBe(first);
  });
});

describe("claimNextBatchQueueItem — lease expiry recovery (CP-3 §3.2)", () => {
  it("reclaims a CLAIMED row whose lease has expired, minting a NEW claim_token distinct from the original", async () => {
    const batchJobId = await trackBatch();
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const itemId = await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    const first = await claimNextBatchQueueItem(db, "EXTRACT", "worker-A", 60, { scopeToBatchJobId: batchJobId });
    expect(first).not.toBeNull();

    // Simulate time passing past the lease, without a real sleep (lessons.md #8).
    await db.update(batchQueueItems).set({ leaseExpiresAt: await dbPastTimestamp(db, 1) }).where(eq(batchQueueItems.id, itemId));

    const second = await claimNextBatchQueueItem(db, "EXTRACT", "worker-B", 60, { scopeToBatchJobId: batchJobId });
    expect(second).not.toBeNull();
    expect(second?.id).toBe(itemId);
    expect(second?.claimedBy).toBe("worker-B");
    expect(second?.claimToken).not.toBe(first?.claimToken);
    expect(second?.attempts).toBe(2); // incremented on every claim, first and reclaim alike
  });

  it("does NOT reclaim a CLAIMED row whose lease has not expired yet", async () => {
    const batchJobId = await trackBatch();
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    const first = await claimNextBatchQueueItem(db, "EXTRACT", "worker-A", 60, { scopeToBatchJobId: batchJobId });
    expect(first).not.toBeNull();

    const second = await claimNextBatchQueueItem(db, "EXTRACT", "worker-B", 60, { scopeToBatchJobId: batchJobId });
    expect(second).toBeNull();
  });
});

describe("claimNextBatchQueueItem — concurrency (the question CP-3 exists to answer)", () => {
  it("ten workers racing for ONE item: exactly one claims it, the rest get null, no errors", async () => {
    const batchJobId = await trackBatch();
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const itemId = await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    const attempts = Array.from({ length: 10 }, (_, i) =>
      claimNextBatchQueueItem(db, "EXTRACT", `worker-${i}`, 60, { scopeToBatchJobId: batchJobId }),
    );
    const results = await Promise.all(attempts);

    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);
    expect(successes[0]?.id).toBe(itemId);
    expect(results.filter((r) => r === null)).toHaveLength(9);
  });

  it("five workers racing for five items: each item claimed exactly once, no duplicate claim_tokens, no duplicate ids", async () => {
    const batchJobId = await trackBatch();
    const itemIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, `img-${i}.jpg`);
      itemIds.push(await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId }));
    }

    const attempts = Array.from({ length: 5 }, (_, i) =>
      claimNextBatchQueueItem(db, "EXTRACT", `worker-${i}`, 60, { scopeToBatchJobId: batchJobId }),
    );
    const results = await Promise.all(attempts);

    expect(results.every((r) => r !== null)).toBe(true);
    const claimedIds = results.map((r) => r?.id);
    expect(new Set(claimedIds).size).toBe(5); // no id claimed twice
    expect(new Set(claimedIds)).toEqual(new Set(itemIds));
    const tokens = results.map((r) => r?.claimToken);
    expect(new Set(tokens).size).toBe(5); // every claim minted its own fresh token
  });

  it("more workers than items: extras get null, real items are never double-claimed", async () => {
    const batchJobId = await trackBatch();
    const itemIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, `img-${i}.jpg`);
      itemIds.push(await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId }));
    }

    const attempts = Array.from({ length: 8 }, (_, i) =>
      claimNextBatchQueueItem(db, "EXTRACT", `worker-${i}`, 60, { scopeToBatchJobId: batchJobId }),
    );
    const results = await Promise.all(attempts);
    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(3);
    expect(new Set(successes.map((r) => r?.id)).size).toBe(3);
  });
});

describe("claimNextBatchQueueItem — input validation (standing rule 13)", () => {
  it("rejects a non-positive leaseSeconds before ever touching the database", async () => {
    await expect(claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 0)).rejects.toThrow(RangeError);
    await expect(claimNextBatchQueueItem(db, "EXTRACT", "worker-1", -5)).rejects.toThrow(RangeError);
  });

  it("rejects a non-finite leaseSeconds (NaN, Infinity)", async () => {
    await expect(claimNextBatchQueueItem(db, "EXTRACT", "worker-1", Number.NaN)).rejects.toThrow(RangeError);
    await expect(claimNextBatchQueueItem(db, "EXTRACT", "worker-1", Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);
  });
});
