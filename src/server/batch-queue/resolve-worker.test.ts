/**
 * `processResolveClaim` against a real Postgres database (LH-041 / TRO-474,
 * CP-3 §3.3, §6, §7.1, §8 step 6). No live Anthropic call — the resolver's
 * OWN `resolveEscalatedLabel` (LH-014, already merged) runs for real
 * against a fake `messages.create`, the same pattern
 * `src/server/resolver/index.test.ts` already uses. This is deliberate:
 * the whole point of §3.3's recovery path is proving THIS ticket's code
 * correctly reacts to the REAL unique-constraint violation
 * `insertReviewQueueEntry` throws, not a stand-in for it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { RateLimitError } from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { batchJobs, batchQueueItems, reviewQueue, verifications } from "../../lib/db/schema";
import { readLabelImage } from "../storage/local-file-storage";
import { makeExtraction } from "../router/test-support";
import { makeFlaggedFields, makeMockMessage, makeRouterResult, WELL_FORMED_RESOLVER_BODY } from "../resolver/test-support";
import { DEFAULT_BACKOFF_CONFIG } from "./backoff";
import { claimNextBatchQueueItem } from "./claim";
import { ESCALATION_CAP_EXCEEDED_SKIP_REASON, reserveSonnetCall } from "./escalation-cap";
import { processResolveClaim, type ResolveWorkerDeps } from "./resolve-worker";
import { buildResolverInputSnapshot } from "./resolver-snapshot";
import {
  cleanupBatchJobFixture,
  createApplicationAndSavedImageFixture,
  createBatchJobFixture,
  createVerificationFixture,
  enqueueResolveItemFixture,
} from "./test-support";

let scratchDir: string;
const createdBatchJobIds: number[] = [];

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro474-resolve-"));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
  for (const id of createdBatchJobIds.splice(0)) {
    await cleanupBatchJobFixture(db, id);
  }
});

async function trackBatch(overrides?: Parameters<typeof createBatchJobFixture>[1]): Promise<number> {
  const id = await createBatchJobFixture(db, overrides);
  createdBatchJobIds.push(id);
  return id;
}

function fakeAnthropicClient(create: () => Promise<Anthropic.Message>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

function clientReturning(body: unknown): Anthropic {
  return fakeAnthropicClient(async () => makeMockMessage(JSON.stringify(body)));
}

function clientThrowing(error: unknown): Anthropic {
  return fakeAnthropicClient(async () => {
    throw error;
  });
}

function makeDeps(overrides: Partial<ResolveWorkerDeps> = {}): ResolveWorkerDeps {
  return {
    db,
    readLabelImage: (storagePath) => readLabelImage(storagePath, { baseDir: scratchDir }),
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
    ...overrides,
  };
}

/** A verification whose escalation snapshot matches `../resolver/test-support.ts`'s
 * own fixtures — guaranteed to pair with `WELL_FORMED_RESOLVER_BODY`. */
async function escalatedFixture(batchJobId: number, filename: string) {
  const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, filename, scratchDir);
  const verificationId = await createVerificationFixture(db, applicationId, labelImageId, batchJobId);
  const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
  await enqueueResolveItemFixture(db, { batchJobId, verificationId, resolverInput: snapshot });
  const claimed = await claimNextBatchQueueItem(db, "RESOLVE", "worker-1", 120, { scopeToBatchJobId: batchJobId });
  if (!claimed) throw new Error("test setup failed: claim returned null");
  return { claimed, verificationId, applicationId, labelImageId };
}

describe("processResolveClaim — resolved", () => {
  it("calls the real resolver, completes DONE, sets resolutionPath EXTRACTOR_RESOLVER, and increments resolvedBySonnetCount", async () => {
    const batchJobId = await trackBatch({ totalCount: 4 }); // cap = 1, plenty for one call
    const { claimed, verificationId } = await escalatedFixture(batchJobId, "resolved.jpg");
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) });

    const outcome = await processResolveClaim(claimed, deps);
    expect(outcome).toEqual({ kind: "done", outcome: "resolved" });

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("DONE");

    const [verificationRow] = await db.select().from(verifications).where(eq(verifications.id, verificationId));
    expect(verificationRow.resolutionPath).toBe("EXTRACTOR_RESOLVER");

    const [queueRow] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(queueRow.resolverOutput).not.toBeNull();
    expect(queueRow.resolverSkipReason).toBeNull();

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.resolvedBySonnetCount).toBe(1);
    expect(job.needsHumanCount).toBe(0);
    expect(job.sonnetCallCount).toBe(1);
  });
});

describe("processResolveClaim — needs-human", () => {
  it("a NEEDS_HUMAN disposition increments needsHumanCount, not resolvedBySonnetCount", async () => {
    const batchJobId = await trackBatch({ totalCount: 4 });
    const { claimed, verificationId } = await escalatedFixture(batchJobId, "needs-human.jpg");
    const needsHumanBody = {
      overall: "NEEDS_HUMAN",
      fields: WELL_FORMED_RESOLVER_BODY.fields.map((f, i) => (i === 0 ? { ...f, disposition: "NEEDS_HUMAN", corrected_value: null } : f)),
    };
    const deps = makeDeps({ anthropicClient: clientReturning(needsHumanBody) });

    const outcome = await processResolveClaim(claimed, deps);
    expect(outcome).toEqual({ kind: "done", outcome: "needs-human" });

    const [verificationRow] = await db.select().from(verifications).where(eq(verifications.id, verificationId));
    expect(verificationRow.resolutionPath).toBe("EXTRACTOR_RESOLVER");

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.needsHumanCount).toBe(1);
    expect(job.resolvedBySonnetCount).toBe(0);
  });
});

describe("processResolveClaim — the escalation cap (CP-3 §6.2)", () => {
  it("skips the Sonnet call once the cap is exhausted: DONE via a skip-marker review_queue row, needsHumanCount++, resolutionPath stays EXTRACTOR_ONLY", async () => {
    const batchJobId = await trackBatch({ totalCount: 4 }); // cap = 1
    const { claimed, verificationId } = await escalatedFixture(batchJobId, "capped.jpg");
    // Exhaust the batch's ENTIRE budget before this worker ever tries.
    expect(await reserveSonnetCall(db, batchJobId, 1)).toBe(true);

    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) }); // must NEVER be called
    const outcome = await processResolveClaim(claimed, deps);
    expect(outcome).toEqual({ kind: "done", outcome: "cap-skipped" });

    const [verificationRow] = await db.select().from(verifications).where(eq(verifications.id, verificationId));
    expect(verificationRow.resolutionPath).toBe("EXTRACTOR_ONLY"); // Sonnet never ran

    const [queueRow] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(queueRow.resolverOutput).toBeNull();
    expect(queueRow.resolverSkipReason).toBe(ESCALATION_CAP_EXCEEDED_SKIP_REASON);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.needsHumanCount).toBe(1);
    expect(job.resolvedBySonnetCount).toBe(0);
    expect(job.sonnetCallCount).toBe(1); // the earlier reservation, not a second one
  });

  it("reserves budget on EVERY attempt, including ones that go on to fail retryably — not only settled outcomes (CP-3 §6.2's own correction)", async () => {
    const batchJobId = await trackBatch({ totalCount: 20 }); // cap = 5
    const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, "flaky.jpg", scratchDir);
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId, batchJobId);
    const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
    await enqueueResolveItemFixture(db, { batchJobId, verificationId, resolverInput: snapshot });

    const error = new RateLimitError(429, { type: "rate_limit_error", message: "rate limited" }, "429", new Headers(), "rate_limit_error");
    const deps = makeDeps({ anthropicClient: clientThrowing(error) });

    const firstClaim = await claimNextBatchQueueItem(db, "RESOLVE", "worker-1", 120, { scopeToBatchJobId: batchJobId });
    const firstOutcome = await processResolveClaim(firstClaim!, deps);
    expect(firstOutcome.kind).toBe("retry");

    const [jobAfterFirst] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(jobAfterFirst.sonnetCallCount).toBe(1); // spent even though the call failed
  });
});

describe("processResolveClaim — TRO-506 recovery (CP-3 §3.3)", () => {
  it("two workers racing for the SAME verification (lease-expiry double-claim): only one review_queue row is ever written, both calls complete without throwing, and the counter increments exactly once", async () => {
    // totalCount 8 -> cap 2, so BOTH workers' own reservation succeeds and
    // both genuinely reach the Sonnet call — a cap of 1 would make the
    // SECOND worker hit the cap-skip path instead, a real but different
    // race (also covered, symmetrically, by its own collision handling in
    // resolve-worker.ts, but not what THIS test means to exercise).
    const batchJobId = await trackBatch({ totalCount: 8 });
    const { claimed: firstClaim, verificationId } = await escalatedFixture(batchJobId, "race.jpg");

    // Simulate the first worker's lease expiring while its Sonnet call was
    // still (slowly) in flight, and a second worker reclaiming the SAME row.
    await db.update(batchQueueItems).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(batchQueueItems.id, firstClaim.id));
    const secondClaim = await claimNextBatchQueueItem(db, "RESOLVE", "worker-2", 120, { scopeToBatchJobId: batchJobId });
    expect(secondClaim?.claimToken).not.toBe(firstClaim.claimToken);

    // Both workers now genuinely race to call Sonnet and insert review_queue
    // for the SAME verificationId — the exact TRO-506 shape.
    const depsA = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) });
    const depsB = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) });
    const [outcomeA, outcomeB] = await Promise.all([processResolveClaim(firstClaim, depsA), processResolveClaim(secondClaim!, depsB)]);

    // Neither call is allowed to throw an uncaught exception (asserted
    // implicitly: Promise.all would reject the whole test if either did).
    // Exactly one review_queue row for this verification, ever.
    const queueRows = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(queueRows).toHaveLength(1);

    // The row still holding the current claim_token (worker B, the
    // reclaiming one) completes normally; the stale worker A discards its
    // own result — "stale", not "failed": it did nothing wrong.
    const outcomes = [outcomeA.kind, outcomeB.kind].sort();
    expect(outcomes).toEqual(["done", "stale"]);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.resolvedBySonnetCount + job.needsHumanCount).toBe(1); // exactly one label counted, not two
  });

  it("a symmetric collision this design also guards against: two cap-skip attempts for the same verification race on the SAME insert — only one skip-marker row is ever written", async () => {
    // Not literally CP-3's own named TRO-506 scenario (that one is real-call
    // vs. real-call) — this is the same class of race reached a different
    // way: BOTH lease-expiry episodes exhaust the cap independently and
    // both try to write a skip-marker row for the same verification.
    // completeCapSkip's own try/catch (resolve-worker.ts) must handle this
    // the same way, not just the real-call case.
    const batchJobId = await trackBatch({ totalCount: 4 }); // cap = 1
    const { claimed: firstClaim, verificationId } = await escalatedFixture(batchJobId, "double-cap-skip.jpg");
    expect(await reserveSonnetCall(db, batchJobId, 1)).toBe(true); // exhaust the cap up front

    await db.update(batchQueueItems).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(batchQueueItems.id, firstClaim.id));
    const secondClaim = await claimNextBatchQueueItem(db, "RESOLVE", "worker-2", 120, { scopeToBatchJobId: batchJobId });

    const depsA = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) }); // must NEVER be called
    const depsB = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) });
    const [outcomeA, outcomeB] = await Promise.all([processResolveClaim(firstClaim, depsA), processResolveClaim(secondClaim!, depsB)]);

    const queueRows = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].resolverSkipReason).toBe(ESCALATION_CAP_EXCEEDED_SKIP_REASON);

    const outcomes = [outcomeA.kind, outcomeB.kind].sort();
    expect(outcomes).toEqual(["done", "stale"]);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.resolvedBySonnetCount + job.needsHumanCount).toBe(1);
  });
});

describe("processResolveClaim — malformed snapshot (CP-3 §2.3 — reject, never guess)", () => {
  it("fails immediately on an unsupported schemaVersion, without ever reserving Sonnet budget", async () => {
    const batchJobId = await trackBatch({ totalCount: 4 });
    const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, "bad-snapshot.jpg", scratchDir);
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId, batchJobId);
    await enqueueResolveItemFixture(db, { batchJobId, verificationId, resolverInput: { schemaVersion: "2" } });
    const claimed = await claimNextBatchQueueItem(db, "RESOLVE", "worker-1", 120, { scopeToBatchJobId: batchJobId });

    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) }); // must NEVER be called
    const outcome = await processResolveClaim(claimed!, deps);
    expect(outcome.kind).toBe("failed");

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed!.id));
    expect(item.status).toBe("FAILED");
    expect(item.lastError).toMatch(/schemaVersion/);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.failedCount).toBe(1);
    expect(job.sonnetCallCount).toBe(0);
  });
});

describe("processResolveClaim — non-retryable resolver failure", () => {
  it("a malformed API response fails the item — failedCount increments, processedCount is untouched (RESOLVE never double-counts EXTRACT's processedCount)", async () => {
    const batchJobId = await trackBatch({ totalCount: 4 });
    const { claimed } = await escalatedFixture(batchJobId, "bad-response.jpg");
    const deps = makeDeps({ anthropicClient: clientReturning({ overall: "RESOLVED", fields: [] }) }); // schema-invalid

    const outcome = await processResolveClaim(claimed, deps);
    expect(outcome.kind).toBe("failed");

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.failedCount).toBe(1);
    expect(job.processedCount).toBe(0);
  });
});
