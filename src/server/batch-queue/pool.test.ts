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
import { startWorkerPool } from "./pool";
import { cleanupBatchJobFixture, createApplicationAndImageFixture, createBatchJobFixture, enqueueExtractItemFixture } from "./test-support";

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
    while (doneAts.length === 0 && Date.now() < deadline) await sleep(10);
    pool.stop();
    await pool.done;

    expect(doneAts.length).toBeGreaterThan(0);
    expect(doneAts[0] - rateLimitAt).toBeGreaterThanOrEqual(COOLDOWN_MS - 50); // small scheduling slack
  });
});
