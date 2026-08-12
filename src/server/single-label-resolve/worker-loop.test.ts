/**
 * `startSingleLabelResolveWorker` against a real Postgres database
 * (TRO-511). Proves the LOOP wires `claimNextReviewQueueResolveItem` and
 * `processSingleLabelResolveClaim` together correctly — real concurrency
 * drains the queue exactly once, `stop()` halts cleanly — the same
 * properties `../batch-queue/pool.test.ts` proves for the batch pools, at a
 * smaller scale appropriate to this queue's own expected volume.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { reviewQueue } from "../../lib/db/schema";
import { readLabelImage } from "../storage/db-image-storage";
import { buildResolverInputSnapshot } from "../batch-queue/resolver-snapshot";
import { DEFAULT_BACKOFF_CONFIG } from "../batch-queue/backoff";
import { makeFlaggedFields, makeMockMessage, makeRouterResult, WELL_FORMED_RESOLVER_BODY } from "../resolver/test-support";
import { makeExtraction } from "../router/test-support";
import { startSingleLabelResolveWorker } from "./worker";
import {
  cleanupApplicationFixture,
  createApplicationAndSavedImageFixture,
  createVerificationFixture,
  enqueuePendingReviewQueueItemFixture,
} from "./test-support";

const createdApplicationIds: number[] = [];

afterEach(async () => {
  for (const id of createdApplicationIds.splice(0)) {
    await cleanupApplicationFixture(db, id);
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeAnthropicClient(create: () => Promise<Anthropic.Message>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

async function seedPendingRow(filename: string): Promise<number> {
  const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, filename);
  createdApplicationIds.push(applicationId);
  const verificationId = await createVerificationFixture(db, applicationId, labelImageId);
  const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
  await enqueuePendingReviewQueueItemFixture(db, verificationId, { reason: "WARNING_MISMATCH", resolverInput: snapshot });
  return verificationId;
}

describe("startSingleLabelResolveWorker — config validation (standing rule 13)", () => {
  const base = {
    db,
    workerIdPrefix: "test",
    leaseSeconds: 60,
    pollIntervalMs: 20,
    readLabelImage,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
  };

  it("rejects a non-positive or non-integer concurrency before starting any loop", () => {
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 0 })).toThrow(RangeError);
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: -1 })).toThrow(RangeError);
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 1.5 })).toThrow(RangeError);
  });

  it("rejects a non-positive or non-finite leaseSeconds", () => {
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 1, leaseSeconds: 0 })).toThrow(RangeError);
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 1, leaseSeconds: -5 })).toThrow(RangeError);
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 1, leaseSeconds: Number.NaN })).toThrow(RangeError);
  });

  it("rejects a non-positive or non-finite pollIntervalMs", () => {
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 1, pollIntervalMs: 0 })).toThrow(RangeError);
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 1, pollIntervalMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe("startSingleLabelResolveWorker — real concurrency drains the queue exactly once", () => {
  // Unlike `../batch-queue/pool.test.ts`'s own equivalent (an instant fake
  // `processClaim`, no real work at all), this test runs the REAL
  // `processSingleLabelResolveClaim` for all 6 rows: a real `sharp` resize
  // per row plus several real DB round trips. Standalone, that finishes in
  // well under a second; under the full suite's own concurrency (~120 test
  // files, several of which also do real image work), CPU contention alone
  // can push it past vitest's 5s default — a load-sensitive failure caught
  // by the gate's own standalone-rerun check, not a logic bug (the internal
  // poll loop below already awaits an observable condition, lessons.md #8;
  // it just needs more real time to become true under contention, not a
  // fixed sleep). Both the internal deadline and vitest's own per-test
  // timeout are widened together — narrowing only one would just move
  // which one fires first.
  it(
    "N=3 concurrent loops process M=6 seeded rows, each exactly once, then idle",
    async () => {
      const verificationIds: number[] = [];
      for (let i = 0; i < 6; i++) {
        verificationIds.push(await seedPendingRow(`loop-${i}.jpg`));
      }

      // The fixture uses the REAL resolveEscalatedLabel (no override)
      // against a fake Anthropic client — success is observed by reading
      // the rows back, the same way the end-to-end worker test observes it.
      const worker = startSingleLabelResolveWorker({
        db,
        workerIdPrefix: "test-loop",
        concurrency: 3,
        leaseSeconds: 60,
        pollIntervalMs: 15,
        readLabelImage,
        backoffConfig: DEFAULT_BACKOFF_CONFIG,
        scopeToVerificationIds: verificationIds,
        anthropicClient: fakeAnthropicClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY))),
      });

      // Poll an observable condition (lessons.md #8) — every seeded row has
      // a non-null resolverOutput — rather than a fixed sleep guessing how
      // long draining six rows across three loops takes. Filters in the
      // query itself (inArray), not in JS over the whole table, so this
      // scales the same way regardless of how many unrelated rows other
      // concurrently running test files happen to have in flight.
      async function countResolved(): Promise<number> {
        const rows = await db.select().from(reviewQueue).where(inArray(reviewQueue.verificationId, verificationIds));
        return rows.filter((r) => r.resolverOutput !== null).length;
      }

      const deadline = Date.now() + 20_000; // generous under full-suite CPU contention — see this test's own comment above
      let doneCount = await countResolved();
      while (doneCount < verificationIds.length && Date.now() < deadline) {
        await sleep(20);
        doneCount = await countResolved();
      }

      worker.stop();
      await worker.done;

      expect(doneCount).toBe(6);

      // Each row claimed exactly once, not reclaimed-and-retried — attempts
      // is incremented on every CLAIM (claim.ts), so a value of 1 per row is
      // the direct proof "drained exactly once" actually means, not just an
      // inference from the final count matching.
      const finalRows = await db.select().from(reviewQueue).where(inArray(reviewQueue.verificationId, verificationIds));
      expect(finalRows).toHaveLength(6);
      expect(finalRows.every((r) => r.attempts === 1)).toBe(true);
    },
    25_000, // vitest's own per-test timeout — must exceed the internal deadline above, or IT fires first
  );
});
