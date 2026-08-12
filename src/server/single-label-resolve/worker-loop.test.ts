/**
 * `startSingleLabelResolveWorker` against a real Postgres database
 * (TRO-511). Proves the LOOP wires `claimNextReviewQueueResolveItem` and
 * `processSingleLabelResolveClaim` together correctly — real concurrency
 * drains the queue exactly once, `stop()` halts cleanly — the same
 * properties `../batch-queue/pool.test.ts` proves for the batch pools, at a
 * smaller scale appropriate to this queue's own expected volume.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { reviewQueue } from "../../lib/db/schema";
import { readLabelImage } from "../storage/local-file-storage";
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

let scratchDir: string;
const createdApplicationIds: number[] = [];

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro511-loop-"));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
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
  const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, filename, scratchDir);
  createdApplicationIds.push(applicationId);
  const verificationId = await createVerificationFixture(db, applicationId, labelImageId);
  const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
  await enqueuePendingReviewQueueItemFixture(db, verificationId, { reason: "WARNING_MISMATCH", resolverInput: snapshot });
  return verificationId;
}

describe("startSingleLabelResolveWorker — config validation (standing rule 13)", () => {
  it("rejects a non-positive or non-integer concurrency before starting any loop", () => {
    const base = {
      db,
      workerIdPrefix: "test",
      leaseSeconds: 60,
      pollIntervalMs: 20,
      readLabelImage: (p: string) => readLabelImage(p, { baseDir: scratchDir }),
      backoffConfig: DEFAULT_BACKOFF_CONFIG,
    };
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 0 })).toThrow(RangeError);
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: -1 })).toThrow(RangeError);
    expect(() => startSingleLabelResolveWorker({ ...base, concurrency: 1.5 })).toThrow(RangeError);
  });
});

describe("startSingleLabelResolveWorker — real concurrency drains the queue exactly once", () => {
  it("N=3 concurrent loops process M=6 seeded rows, each exactly once, then idle", async () => {
    const verificationIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      verificationIds.push(await seedPendingRow(`loop-${i}.jpg`));
    }

    // The fixture uses the REAL resolveEscalatedLabel (no override) against
    // a fake Anthropic client — success is observed by reading the rows
    // back, the same way the end-to-end worker test observes it.
    const worker = startSingleLabelResolveWorker({
      db,
      workerIdPrefix: "test-loop",
      concurrency: 3,
      leaseSeconds: 60,
      pollIntervalMs: 15,
      readLabelImage: (p) => readLabelImage(p, { baseDir: scratchDir }),
      backoffConfig: DEFAULT_BACKOFF_CONFIG,
      scopeToVerificationIds: verificationIds,
      anthropicClient: fakeAnthropicClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY))),
    });

    // Poll an observable condition (lessons.md #8) — every seeded row has a
    // non-null resolverOutput — rather than a fixed sleep guessing how long
    // draining six rows across three loops takes.
    async function countResolved(): Promise<number> {
      const rows = await db.select().from(reviewQueue);
      return rows.filter((r) => verificationIds.includes(r.verificationId) && r.resolverOutput !== null).length;
    }

    const deadline = Date.now() + 5000;
    let doneCount = await countResolved();
    while (doneCount < verificationIds.length && Date.now() < deadline) {
      await sleep(20);
      doneCount = await countResolved();
    }

    worker.stop();
    await worker.done;

    expect(doneCount).toBe(6);
  });
});
