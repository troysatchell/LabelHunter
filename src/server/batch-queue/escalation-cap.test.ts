/**
 * The Sonnet escalation cap against a real Postgres database (LH-041 /
 * TRO-474, CP-3 §6). `reserveSonnetCall` is an atomic `UPDATE ... WHERE
 * sonnet_call_count < cap RETURNING` — the same shape as the claim
 * primitive, and for the same reason: a plain `SELECT` then compare would
 * let two concurrent reservations both read "under budget."
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { batchJobs } from "../../lib/db/schema";
import { computeSonnetCallCapThreshold, reserveSonnetCall } from "./escalation-cap";
import { cleanupBatchJobFixture, createBatchJobFixture } from "./test-support";

const createdBatchJobIds: number[] = [];

afterEach(async () => {
  for (const id of createdBatchJobIds.splice(0)) {
    await cleanupBatchJobFixture(db, id);
  }
});

async function trackBatch(totalCount: number): Promise<number> {
  const id = await createBatchJobFixture(db, { totalCount });
  createdBatchJobIds.push(id);
  return id;
}

describe("computeSonnetCallCapThreshold (CP-3 §6.1)", () => {
  it("is 25% of totalCount, rounded UP", () => {
    expect(computeSonnetCallCapThreshold(300)).toBe(75);
    expect(computeSonnetCallCapThreshold(100)).toBe(25);
  });

  it("never floors to zero — a 1-label batch still gets one call of budget", () => {
    expect(computeSonnetCallCapThreshold(1)).toBe(1);
  });

  it("rounds a small batch up, not down (a 3-label batch caps at 1, not 0)", () => {
    expect(computeSonnetCallCapThreshold(3)).toBe(1);
    expect(computeSonnetCallCapThreshold(4)).toBe(1);
    expect(computeSonnetCallCapThreshold(5)).toBe(2);
  });
});

describe("reserveSonnetCall", () => {
  it("succeeds and increments sonnet_call_count when under the cap", async () => {
    const batchJobId = await trackBatch(100); // cap = 25
    const reserved = await reserveSonnetCall(db, batchJobId, 25);
    expect(reserved).toBe(true);
    const [row] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(row.sonnetCallCount).toBe(1);
  });

  it("fails once sonnet_call_count reaches the cap, leaving the count unchanged", async () => {
    const batchJobId = await trackBatch(4); // cap = 1
    expect(await reserveSonnetCall(db, batchJobId, 1)).toBe(true);
    expect(await reserveSonnetCall(db, batchJobId, 1)).toBe(false);
    const [row] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(row.sonnetCallCount).toBe(1); // the failed attempt did not increment it further
  });

  it("counts EVERY reservation attempt, including ones for retries of the same item — not settled outcomes (CP-3 §6.2's correction)", async () => {
    const batchJobId = await trackBatch(20); // cap = 5
    // Five attempts for what could all be the SAME escalated label, retried
    // after each failure — every attempt still spends one unit of budget.
    for (let i = 0; i < 5; i++) {
      expect(await reserveSonnetCall(db, batchJobId, 5)).toBe(true);
    }
    expect(await reserveSonnetCall(db, batchJobId, 5)).toBe(false);
    const [row] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(row.sonnetCallCount).toBe(5);
  });

  it("ten concurrent reservations against a cap of 3: exactly three succeed, count lands on exactly 3", async () => {
    const batchJobId = await trackBatch(12); // cap = 3
    const attempts = Array.from({ length: 10 }, () => reserveSonnetCall(db, batchJobId, 3));
    const results = await Promise.all(attempts);
    expect(results.filter(Boolean)).toHaveLength(3);
    const [row] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(row.sonnetCallCount).toBe(3);
  });
});
