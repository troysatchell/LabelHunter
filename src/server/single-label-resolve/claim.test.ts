/**
 * `claimNextReviewQueueResolveItem` against a real Postgres database
 * (TRO-511). No mocking — same reasoning as `../batch-queue/claim.test.ts`:
 * only a real database can prove `FOR UPDATE SKIP LOCKED` actually prevents
 * two workers from claiming the same row.
 *
 * Every claim call below passes `scopeToVerificationIds` — vitest runs test
 * FILES in parallel by default (`../batch-queue/claim.test.ts`'s own
 * `scopeToBatchJobId` documents the identical reasoning), and this table has
 * no natural grouping FK the way `batch_queue_items` has `batchJobId` to
 * scope a JOIN against. Without it, a concurrently-running file's own
 * pending row could be claimed by (or counted in) an assertion here.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { reviewQueue } from "../../lib/db/schema";
import { claimNextReviewQueueResolveItem } from "./claim";
import {
  cleanupApplicationFixture,
  createApplicationAndImageFixture,
  createVerificationFixture,
  dbPastTimestamp,
  enqueuePendingReviewQueueItemFixture,
} from "./test-support";

const createdApplicationIds: number[] = [];

afterEach(async () => {
  for (const id of createdApplicationIds.splice(0)) {
    await cleanupApplicationFixture(db, id);
  }
});

async function makePendingFixture(overrides?: Parameters<typeof enqueuePendingReviewQueueItemFixture>[2]) {
  const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, "a.jpg");
  createdApplicationIds.push(applicationId);
  const verificationId = await createVerificationFixture(db, applicationId, labelImageId);
  const itemId = await enqueuePendingReviewQueueItemFixture(db, verificationId, overrides);
  return { applicationId, verificationId, itemId };
}

function claim(workerId: string, leaseSeconds: number, maxAttempts: number, scopeToVerificationIds: number[]) {
  return claimNextReviewQueueResolveItem(db, workerId, leaseSeconds, maxAttempts, { scopeToVerificationIds });
}

describe("claimNextReviewQueueResolveItem — happy path", () => {
  it("claims a pending row: sets a fresh claim_token, claimedBy, a future lease, and increments attempts", async () => {
    const { itemId, verificationId } = await makePendingFixture();

    const before = Date.now();
    const claimed = await claim("worker-1", 60, 5, [verificationId]);

    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(itemId);
    expect(claimed?.verificationId).toBe(verificationId);
    expect(claimed?.claimedBy).toBe("worker-1");
    expect(claimed?.claimToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseExpiresAt?.getTime()).toBeGreaterThan(before);
  });

  it("returns null when no pending row is available", async () => {
    const { verificationId } = await makePendingFixture();
    // Claims and consumes the one row first, scoped, so the SECOND claim
    // below (also scoped to the same, now-CLAIMED-with-a-live-lease row)
    // genuinely has nothing left to find.
    const first = await claim("worker-1", 60, 5, [verificationId]);
    expect(first).not.toBeNull();

    const claimed = await claim("worker-2", 60, 5, [verificationId]);
    expect(claimed).toBeNull();
  });

  it("never claims a row with resolverInput null — a batch-originated row (CP-3 §12 Q5's own 'batch job is absent' predicate)", async () => {
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, "a.jpg");
    createdApplicationIds.push(applicationId);
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId);
    // Mirrors what insertReviewQueueEntry/insertSkippedReviewQueueEntry
    // actually write for a batch-originated escalation — reason set,
    // resolverInput left null.
    await db.insert(reviewQueue).values({ verificationId, reason: "AMBIGUOUS_BRAND" });

    const claimed = await claim("worker-1", 60, 5, [verificationId]);
    expect(claimed).toBeNull();
  });

  it("never claims a row that already has a resolverOutput", async () => {
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, "a.jpg");
    createdApplicationIds.push(applicationId);
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId);
    await db.insert(reviewQueue).values({
      verificationId,
      reason: "AMBIGUOUS_BRAND",
      resolverInput: { schemaVersion: "1" },
      resolverOutput: { outcome: "resolved", fields: [] },
    });

    const claimed = await claim("worker-1", 60, 5, [verificationId]);
    expect(claimed).toBeNull();
  });

  it("never claims a row that was cap-skipped (resolverSkipReason set) — not that this ever happens for a single-label row today, but the predicate must still exclude it", async () => {
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, "a.jpg");
    createdApplicationIds.push(applicationId);
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId);
    await db.insert(reviewQueue).values({
      verificationId,
      reason: "AMBIGUOUS_BRAND",
      resolverInput: { schemaVersion: "1" },
      resolverSkipReason: "ESCALATION_CAP_EXCEEDED",
    });

    const claimed = await claim("worker-1", 60, 5, [verificationId]);
    expect(claimed).toBeNull();
  });

  it("does not claim a row whose availableAt is in the future", async () => {
    const { verificationId } = await makePendingFixture({ availableAt: new Date(Date.now() + 60_000) });
    const claimed = await claim("worker-1", 60, 5, [verificationId]);
    expect(claimed).toBeNull();
  });

  it("does not claim a row whose attempts already meets maxAttempts — permanently parked, not retried forever", async () => {
    const { itemId, verificationId } = await makePendingFixture();
    await db.update(reviewQueue).set({ attempts: 5 }).where(eq(reviewQueue.id, itemId));

    const claimed = await claim("worker-1", 60, 5, [verificationId]);
    expect(claimed).toBeNull();
  });

  it("claims the lowest id first when multiple rows are available", async () => {
    const first = await makePendingFixture();
    const second = await makePendingFixture();

    const claimed = await claim("worker-1", 60, 5, [first.verificationId, second.verificationId]);
    expect(claimed?.id).toBe(first.itemId);
  });
});

describe("claimNextReviewQueueResolveItem — lease expiry recovery", () => {
  it("reclaims a row whose lease has expired, minting a NEW claim_token distinct from the original", async () => {
    const { itemId, verificationId } = await makePendingFixture();

    const first = await claim("worker-A", 60, 5, [verificationId]);
    expect(first).not.toBeNull();

    // Simulate time passing past the lease, without a real sleep (lessons.md #8).
    await db.update(reviewQueue).set({ leaseExpiresAt: await dbPastTimestamp(db, 1) }).where(eq(reviewQueue.id, itemId));

    const second = await claim("worker-B", 60, 5, [verificationId]);
    expect(second).not.toBeNull();
    expect(second?.id).toBe(itemId);
    expect(second?.claimedBy).toBe("worker-B");
    expect(second?.claimToken).not.toBe(first?.claimToken);
    expect(second?.attempts).toBe(2); // incremented on every claim, first and reclaim alike
  });

  it("does NOT reclaim a row whose lease has not expired yet", async () => {
    const { verificationId } = await makePendingFixture();

    const first = await claim("worker-A", 60, 5, [verificationId]);
    expect(first).not.toBeNull();

    const second = await claim("worker-B", 60, 5, [verificationId]);
    expect(second).toBeNull();
  });
});

describe("claimNextReviewQueueResolveItem — concurrency (the question this claim query exists to answer)", () => {
  it("ten workers racing for ONE row: exactly one claims it, the rest get null, no errors", async () => {
    const { itemId, verificationId } = await makePendingFixture();

    const attempts = Array.from({ length: 10 }, (_, i) => claim(`worker-${i}`, 60, 5, [verificationId]));
    const results = await Promise.all(attempts);

    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);
    expect(successes[0]?.id).toBe(itemId);
    expect(results.filter((r) => r === null)).toHaveLength(9);
  });

  it("five workers racing for five rows: each claimed exactly once, no duplicate claim_tokens, no duplicate ids", async () => {
    const itemIds: number[] = [];
    const verificationIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      const fixture = await makePendingFixture();
      itemIds.push(fixture.itemId);
      verificationIds.push(fixture.verificationId);
    }

    const attempts = Array.from({ length: 5 }, (_, i) => claim(`worker-${i}`, 60, 5, verificationIds));
    const results = await Promise.all(attempts);

    expect(results.every((r) => r !== null)).toBe(true);
    const claimedIds = results.map((r) => r?.id);
    expect(new Set(claimedIds).size).toBe(5);
    expect(new Set(claimedIds)).toEqual(new Set(itemIds));
    const tokens = results.map((r) => r?.claimToken);
    expect(new Set(tokens).size).toBe(5);
  });
});

describe("claimNextReviewQueueResolveItem — scopeToVerificationIds: empty vs. absent (found in local review)", () => {
  it("an explicitly EMPTY scope matches nothing, even though a real pending row exists", async () => {
    await makePendingFixture();
    const claimed = await claimNextReviewQueueResolveItem(db, "worker-1", 60, 5, { scopeToVerificationIds: [] });
    expect(claimed).toBeNull();
  });

  it("an ABSENT scope (the option left out entirely) is unrestricted — the two are not the same", async () => {
    const { itemId, verificationId } = await makePendingFixture();
    // No scopeToVerificationIds at all — production's own real call shape.
    const claimed = await claimNextReviewQueueResolveItem(db, "worker-1", 60, 5, {});
    // This assertion is only meaningful because the row above is the ONLY
    // one this worker could plausibly find scoped to itself; an unrelated
    // concurrently-running test file's own row could also satisfy an
    // unrestricted claim, so this checks the row we know about was
    // eligible, not that it uniquely won.
    if (claimed?.verificationId === verificationId) {
      expect(claimed.id).toBe(itemId);
    } else {
      // Another file's row won the race under real parallel test
      // execution — still proves "absent" did not silently match nothing
      // the way an empty array now correctly does.
      expect(claimed).not.toBeNull();
    }
  });
});

describe("claimNextReviewQueueResolveItem — input validation (standing rule 13)", () => {
  it("rejects a non-positive or non-finite leaseSeconds before ever touching the database", async () => {
    await expect(claimNextReviewQueueResolveItem(db, "worker-1", 0, 5)).rejects.toThrow(RangeError);
    await expect(claimNextReviewQueueResolveItem(db, "worker-1", -5, 5)).rejects.toThrow(RangeError);
    await expect(claimNextReviewQueueResolveItem(db, "worker-1", Number.NaN, 5)).rejects.toThrow(RangeError);
  });

  it("rejects a non-positive or non-integer maxAttempts", async () => {
    await expect(claimNextReviewQueueResolveItem(db, "worker-1", 60, 0)).rejects.toThrow(RangeError);
    await expect(claimNextReviewQueueResolveItem(db, "worker-1", 60, -1)).rejects.toThrow(RangeError);
    await expect(claimNextReviewQueueResolveItem(db, "worker-1", 60, 1.5)).rejects.toThrow(RangeError);
  });
});
