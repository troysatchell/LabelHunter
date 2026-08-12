/**
 * `startWorkerPool` against a real Postgres database (LH-041 / TRO-474,
 * CP-3 §4.5, §5.3). The lower-level claim/completion-guard/backoff races
 * are already proven in `claim.test.ts`/`complete.test.ts`/`backoff.test.ts`
 * — this suite proves the LOOP wires them together correctly: real
 * concurrency drains a queue exactly once, `stop()` halts cleanly, and a
 * rate-limit outcome pauses the whole pool's claiming, not just one item.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { batchQueueItems } from "../../lib/db/schema";
import { markDone } from "./complete";
import { computeLoopErrorBackoffMs, LOOP_ERROR_BASE_BACKOFF_MS, LOOP_ERROR_MAX_BACKOFF_MS, startWorkerPool } from "./pool";
import { cleanupBatchJobFixture, createApplicationAndImageFixture, createBatchJobFixture, enqueueExtractItemFixture } from "./test-support";

describe("computeLoopErrorBackoffMs — the pure formula", () => {
  it("doubles from the base for each consecutive error, and caps at the max", () => {
    expect(computeLoopErrorBackoffMs(1)).toBe(LOOP_ERROR_BASE_BACKOFF_MS); // 1000
    expect(computeLoopErrorBackoffMs(2)).toBe(2000);
    expect(computeLoopErrorBackoffMs(3)).toBe(4000);
    expect(computeLoopErrorBackoffMs(4)).toBe(8000);
    expect(computeLoopErrorBackoffMs(5)).toBe(16000);
    expect(computeLoopErrorBackoffMs(6)).toBe(LOOP_ERROR_MAX_BACKOFF_MS); // 32000 would exceed the 30000 cap
    expect(computeLoopErrorBackoffMs(10)).toBe(LOOP_ERROR_MAX_BACKOFF_MS); // stays capped, does not keep growing
  });

  it("accepts a custom config — how the new test below runs fast without waiting out the real 1s/30s values", () => {
    const small = { baseMs: 20, maxMs: 100 };
    expect(computeLoopErrorBackoffMs(1, small)).toBe(20);
    expect(computeLoopErrorBackoffMs(2, small)).toBe(40);
    expect(computeLoopErrorBackoffMs(3, small)).toBe(80);
    expect(computeLoopErrorBackoffMs(4, small)).toBe(100); // capped
  });
});

const createdBatchJobIds: number[] = [];

afterEach(async () => {
  for (const id of createdBatchJobIds.splice(0)) {
    await cleanupBatchJobFixture(db, id);
  }
});

async function trackBatch(): Promise<number> {
  const id = await createBatchJobFixture(db);
  createdBatchJobIds.push(id);
  return id;
}

function baseConfig(): Parameters<typeof startWorkerPool>[0] {
  return {
    db,
    kind: "EXTRACT",
    concurrency: 1,
    leaseSeconds: 60,
    workerIdPrefix: "test-pool-validation",
    pollIntervalMs: 20,
    processClaim: async () => ({ kind: "done" }),
  };
}

describe("startWorkerPool — config validation (standing rule 13)", () => {
  it("rejects a non-positive or non-integer concurrency before starting any loop", () => {
    expect(() => startWorkerPool({ ...baseConfig(), concurrency: 0 })).toThrow(RangeError);
    expect(() => startWorkerPool({ ...baseConfig(), concurrency: -1 })).toThrow(RangeError);
    expect(() => startWorkerPool({ ...baseConfig(), concurrency: 1.5 })).toThrow(RangeError);
  });

  it("rejects a non-positive or non-finite leaseSeconds", () => {
    expect(() => startWorkerPool({ ...baseConfig(), leaseSeconds: 0 })).toThrow(RangeError);
    expect(() => startWorkerPool({ ...baseConfig(), leaseSeconds: Number.NaN })).toThrow(RangeError);
  });

  it("rejects a non-positive or non-finite pollIntervalMs", () => {
    expect(() => startWorkerPool({ ...baseConfig(), pollIntervalMs: 0 })).toThrow(RangeError);
    expect(() => startWorkerPool({ ...baseConfig(), pollIntervalMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startWorkerPool — real concurrency drains the queue exactly once", () => {
  it("N=3 concurrent workers process M=10 seeded items, each exactly once, then idle", async () => {
    const batchJobId = await trackBatch();
    const itemIds: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, `p${i}.jpg`);
      itemIds.push(await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId }));
    }

    const processed: number[] = [];
    const pool = startWorkerPool({
      db,
      kind: "EXTRACT",
      concurrency: 3,
      leaseSeconds: 60,
      workerIdPrefix: "test-pool",
      pollIntervalMs: 20,
      scopeToBatchJobId: batchJobId,
      processClaim: async (item) => {
        processed.push(item.id);
        const ok = await markDone(db, item.id, item.claimToken as string);
        return { kind: ok ? "done" : "stale" };
      },
    });

    // Wait until every item is processed, or time out — no fixed sleep
    // guessing how long draining takes (lessons.md #8): poll an observable
    // condition instead.
    const deadline = Date.now() + 5000;
    while (processed.length < 10 && Date.now() < deadline) {
      await sleep(20);
    }
    pool.stop();
    await pool.done;

    expect(processed.sort((a, b) => a - b)).toEqual([...itemIds].sort((a, b) => a - b));
    const rows = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    expect(rows.every((r) => r.status === "DONE")).toBe(true);
  });

  it("stop() halts claiming — done resolves and no further items are claimed afterward", async () => {
    const batchJobId = await trackBatch();
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "only.jpg");
    await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    let claims = 0;
    const pool = startWorkerPool({
      db,
      kind: "EXTRACT",
      concurrency: 2,
      leaseSeconds: 60,
      workerIdPrefix: "test-pool-stop",
      pollIntervalMs: 20,
      scopeToBatchJobId: batchJobId,
      processClaim: async (item) => {
        claims++;
        await markDone(db, item.id, item.claimToken as string);
        return { kind: "done" };
      },
    });

    const deadline = Date.now() + 2000;
    while (claims < 1 && Date.now() < deadline) {
      await sleep(20);
    }
    pool.stop();
    await pool.done;
    const claimsAtStop = claims;

    await sleep(200); // give a misbehaving loop a real chance to claim again
    expect(claims).toBe(claimsAtStop);
  });
});

describe("startWorkerPool — whole-pool cooldown (CP-3 §5.3)", () => {
  it("a rate-limit outcome pauses EVERY loop's claiming — not just the one that hit it — until the cooldown clears", async () => {
    // Seed exactly one item so exactly one of the two loops claims
    // anything at first; the other finds nothing and idles. This avoids a
    // genuine race in testing concurrency=3-from-the-start (multiple loops
    // can each legitimately be "the first claim," making "first vs second
    // claim timing" nondeterministic) — the assertion below instead checks
    // an invariant that holds regardless of WHICH loop does what: no claim
    // succeeds inside the cooldown window this test opens, full stop.
    const batchJobId = await trackBatch();
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, "trigger.jpg");
    await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });

    const COOLDOWN_MS = 400;
    let rateLimitAt = 0;
    const doneAts: number[] = [];
    const pool = startWorkerPool({
      db,
      kind: "EXTRACT",
      concurrency: 2,
      leaseSeconds: 60,
      workerIdPrefix: "test-pool-cooldown",
      pollIntervalMs: 15,
      scopeToBatchJobId: batchJobId,
      processClaim: async (item) => {
        if (rateLimitAt === 0) {
          rateLimitAt = Date.now();
          return { kind: "retry", delayMs: COOLDOWN_MS, isRateLimit: true };
        }
        doneAts.push(Date.now());
        await markDone(db, item.id, item.claimToken as string);
        return { kind: "done" };
      },
    });

    // Wait for the rate-limit outcome to actually fire.
    let deadline = Date.now() + 2000;
    while (rateLimitAt === 0 && Date.now() < deadline) await sleep(10);
    expect(rateLimitAt).toBeGreaterThan(0);

    // Only NOW seed fresh work — available immediately, but the pool-wide
    // cooldown (not item availability) is what must gate claiming it.
    const fresh: number[] = [];
    for (let i = 0; i < 4; i++) {
      const pair = await createApplicationAndImageFixture(db, batchJobId, `fresh${i}.jpg`);
      fresh.push(await enqueueExtractItemFixture(db, { batchJobId, applicationId: pair.applicationId, labelImageId: pair.labelImageId }));
    }

    deadline = Date.now() + 3000;
    while (doneAts.length < fresh.length && Date.now() < deadline) await sleep(10);
    pool.stop();
    await pool.done;

    // ALL FOUR seeded items eventually drain once the cooldown clears —
    // not just the first one claimed after it. The cooldown gates the
    // pool's claiming for a while, it does not permanently starve it.
    expect(doneAts).toHaveLength(4);
    expect(doneAts[0] - rateLimitAt).toBeGreaterThanOrEqual(COOLDOWN_MS - 50); // small scheduling slack
  });
});

describe("startWorkerPool — this loop's own error backoff (distinct from the item/rate-limit backoffs above)", () => {
  it("escalates consecutiveErrors across repeated processClaim throws, instead of wrongly resetting after every successful claim", async () => {
    // Four seeded items, one loop, processClaim throws every time: each
    // throw leaves its item CLAIMED with a live lease (processClaim never
    // reaches a completion call), so each of the four throws corresponds
    // to a genuinely NEW claim, never a reclaim of the same row — the
    // sequence below is really four separate attempts, not one repeated.
    const batchJobId = await trackBatch();
    for (let i = 0; i < 4; i++) {
      const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, batchJobId, `err${i}.jpg`);
      await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });
    }

    const seenConsecutiveErrors: number[] = [];
    const pool = startWorkerPool({
      db,
      kind: "EXTRACT",
      concurrency: 1, // a single loop keeps the consecutiveErrors sequence deterministic
      leaseSeconds: 60,
      workerIdPrefix: "test-pool-error-backoff",
      pollIntervalMs: 10,
      scopeToBatchJobId: batchJobId,
      loopErrorBackoff: { baseMs: 20, maxMs: 200 }, // real setTimeout delays, just small ones — no fake timers needed
      processClaim: async () => {
        throw new Error("processClaim always fails");
      },
      onLoopError: (_error, _workerId, consecutiveErrors) => {
        seenConsecutiveErrors.push(consecutiveErrors);
      },
    });

    const deadline = Date.now() + 3000;
    while (seenConsecutiveErrors.length < 4 && Date.now() < deadline) {
      await sleep(10);
    }
    pool.stop();
    await pool.done;

    // The bug this guards against: resetting consecutiveErrors right after
    // the CLAIM succeeded, before processClaim had a chance to throw, meant
    // a processClaim that fails on every single attempt never actually
    // escalated — it always incremented from 0, landing on 1 forever:
    // [1, 1, 1, 1]. Fixed, a run of throws climbs: 1, 2, 3, 4.
    expect(seenConsecutiveErrors).toEqual([1, 2, 3, 4]);
  });
});
