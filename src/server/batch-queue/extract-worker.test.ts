/**
 * `processExtractClaim` against a real Postgres database (LH-041 / TRO-474,
 * CP-3 §2.4, §7.1, §8). No live Anthropic call — every extractor response
 * is a canned `makeMockMessage`, the same pattern
 * `src/app/api/verify/route.test.ts` already uses.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { batchJobs, batchQueueItems, fieldResults, reviewQueue, verifications } from "../../lib/db/schema";
import { productionComparators } from "../comparators";
import { HaikuExtractionError } from "../extractor";
import { makeMockMessage, WELL_FORMED_EXTRACTION_BODY } from "../extractor/test-support";
import { readLabelImage } from "../storage/local-file-storage";
import { claimNextBatchQueueItem } from "./claim";
import { DEFAULT_BACKOFF_CONFIG } from "./backoff";
import { processExtractClaim, type ExtractWorkerDeps } from "./extract-worker";
import { parseResolverInputSnapshot } from "./resolver-snapshot";
import {
  cleanupBatchJobFixture,
  createApplicationAndSavedImageFixture,
  createBatchJobFixture,
  dbPastTimestamp,
  enqueueExtractItemFixture,
} from "./test-support";

let scratchDir: string;
const createdBatchJobIds: number[] = [];

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro474-extract-"));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
  // Promise.allSettled, not a sequential loop: one rejected cleanup must
  // not leave the REST of this test's fixture rows behind uncleaned —
  // that would leak into later tests (this suite already documents one
  // real cross-file collision risk from leftover fixture data,
  // test-support.ts's own "Old Tom Distillery" comment). Still surfaces a
  // failure afterward rather than swallowing it silently.
  const ids = createdBatchJobIds.splice(0);
  const results = await Promise.allSettled(ids.map((id) => cleanupBatchJobFixture(db, id)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`afterEach: ${failures.length}/${ids.length} batch job cleanups failed: ${failures.map((f) => String(f.reason)).join("; ")}`);
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

function makeDeps(overrides: Partial<ExtractWorkerDeps> = {}): ExtractWorkerDeps {
  return {
    db,
    comparators: productionComparators,
    readLabelImage: (storagePath) => readLabelImage(storagePath, { baseDir: scratchDir }),
    warningResult: null,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
    ...overrides,
  };
}

async function claimedFixture(batchJobId: number, filename: string, applicationOverrides?: Parameters<typeof createApplicationAndSavedImageFixture>[4]) {
  const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, filename, scratchDir, applicationOverrides);
  await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });
  const claimed = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
  if (!claimed) throw new Error("test setup failed: claim returned null");
  return claimed;
}

describe("processExtractClaim — PASS", () => {
  it("persists verifications/field_results, marks the item DONE, and increments processedCount + autoVerifiedCount", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    // brandName/classType explicitly matching WELL_FORMED_EXTRACTION_BODY —
    // needed for a real comparator MATCH here specifically (test-support.ts's
    // own default is deliberately NOT this shared value; see its comment).
    const claimed = await claimedFixture(batchJobId, "pass.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      warningResult: { verdict: "MATCH" }, // injected — see extract-worker.ts's own file comment on why
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("PASS");
    expect(outcome.escalated).toBe(false);

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("DONE");

    const [verificationRow] = await db.select().from(verifications).where(eq(verifications.id, outcome.verificationId));
    expect(verificationRow.verdict).toBe("PASS");
    expect(verificationRow.resolutionPath).toBe("EXTRACTOR_ONLY");
    expect(verificationRow.batchJobId).toBe(batchJobId);

    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    expect(persistedFields).toHaveLength(5);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.processedCount).toBe(1);
    expect(job.autoVerifiedCount).toBe(1);
    expect(job.status).toBe("COMPLETED"); // the only item — maybeCompleteBatchJob fires

    const resolveRows = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    expect(resolveRows.filter((r) => r.kind === "RESOLVE")).toHaveLength(0);
  });
});

describe("processExtractClaim — FAIL", () => {
  it("a genuine ABV mismatch: verdict FAIL, autoVerifiedCount STILL increments (CP-3 §7.1 — PASS and FAIL bundle together)", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    // brandName/classType matching WELL_FORMED_EXTRACTION_BODY so brand/class
    // MATCH cleanly, isolating the ABV mismatch as the only NEEDS_REVIEW/FAIL
    // driver this test means to exercise.
    const claimed = await claimedFixture(batchJobId, "fail.jpg", {
      abvPercent: 10, // WELL_FORMED says 45%
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
    });
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      warningResult: { verdict: "MATCH" },
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("FAIL");

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.processedCount).toBe(1);
    expect(job.autoVerifiedCount).toBe(1);
  });
});

describe("processExtractClaim — REVIEW / escalation (CP-3 §2.3, §8 step 5)", () => {
  it("escalates: inserts a RESOLVE batch_queue_item with a schemaVersion-1 snapshot, no review_queue row yet, and does NOT bump autoVerifiedCount", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "review.jpg");
    // warningResult defaults to null — a present warning with no comparator
    // result routes to REVIEW (the current, honest behavior this ticket
    // inherits from ../../app/api/verify/route.ts, LH-020 not yet wired in).
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("REVIEW");
    expect(outcome.escalated).toBe(true);

    const [verificationRow] = await db.select().from(verifications).where(eq(verifications.id, outcome.verificationId));
    expect(verificationRow.verdict).toBe("REVIEW");
    expect(verificationRow.resolutionPath).toBe("EXTRACTOR_ONLY"); // Sonnet has not run yet

    // No review_queue row directly from the EXTRACT worker — that write
    // belongs to resolveEscalatedLabel alone (CP-3 §8 steps 5–6).
    const queueRows = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, outcome.verificationId));
    expect(queueRows).toHaveLength(0);

    const resolveItems = await db.select().from(batchQueueItems).where(eq(batchQueueItems.batchJobId, batchJobId));
    const resolveRow = resolveItems.find((r) => r.kind === "RESOLVE");
    expect(resolveRow).toBeDefined();
    expect(resolveRow?.status).toBe("PENDING");
    expect(resolveRow?.verificationId).toBe(outcome.verificationId);
    // The REAL validator, not a type cast — a cast only tells the compiler
    // to trust the shape, it proves nothing about what actually got
    // persisted. Running the row through parseResolverInputSnapshot (the
    // same function the resolve-worker itself uses to read this column)
    // proves the EXTRACT worker wrote something the RESOLVE worker can
    // actually consume, not just something that happens to compile.
    const parsed = parseResolverInputSnapshot(resolveRow?.resolverInput);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.snapshot.schemaVersion).toBe("1");
    expect(parsed.snapshot.flaggedFields.length).toBeGreaterThan(0);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.processedCount).toBe(1);
    expect(job.autoVerifiedCount).toBe(0);
    // The batch is NOT complete — the RESOLVE item it just spawned is still PENDING.
    expect(job.status).toBe("RUNNING");
  });
});

describe("processExtractClaim — retryable failure (CP-3 §5)", () => {
  it("a 429 releases the item to PENDING with availableAt pushed forward, and touches no batchJobs counters", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "retry.jpg");
    const headers = new Headers({ "retry-after": "2" });
    const error = new RateLimitError(429, { type: "rate_limit_error", message: "rate limited" }, "429", headers, "rate_limit_error");
    const deps = makeDeps({ anthropicClient: clientThrowing(error) });
    // The database's own clock — a 100ms Node-vs-Postgres margin is tighter
    // than this suite wants to rely on (see test-support.ts's own
    // clock-skew comment for the class of flake a Node-side timestamp
    // risks here).
    const [{ before }] = await db.execute<{ before: string }>(sql`SELECT now() AS before`).then((r) => r.rows);

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") throw new Error("unreachable");
    // isRateLimit specifically true for a 429 — pool.ts's whole-pool
    // cooldown (CP-3 §5.3) only ever engages on THIS flag, so asserting
    // just outcome.kind here would miss a classifyModelCallError
    // regression that reported the right retry decision for the wrong
    // reason.
    expect(outcome.isRateLimit).toBe(true);

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("PENDING");
    expect(item.claimedBy).toBeNull();
    expect(item.availableAt.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime() + 1900); // ~2s retry-after honored

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.processedCount).toBe(0);
  });

  it("a non-rate-limit retryable error (5xx) also releases to PENDING, but isRateLimit is false — must NOT trigger the pool-wide cooldown", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "retry-500.jpg");
    const error = new InternalServerError(500, { type: "api_error", message: "internal server error" }, "500", new Headers(), "api_error");
    const deps = makeDeps({ anthropicClient: clientThrowing(error) });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") throw new Error("unreachable");
    expect(outcome.isRateLimit).toBe(false);

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("PENDING");
  });

  it("exhausting maxAttempts turns a retryable failure into a permanent one — processedCount and failedCount both increment (CP-3 §7.1)", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, "exhaust.jpg", scratchDir);
    const itemId = await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });
    const error = new RateLimitError(429, { type: "rate_limit_error", message: "rate limited" }, "429", new Headers(), "rate_limit_error");
    const deps = makeDeps({ anthropicClient: clientThrowing(error), backoffConfig: { ...DEFAULT_BACKOFF_CONFIG, maxAttempts: 2, baseDelayMs: 1 } });

    // Attempt 1: retryable, under maxAttempts (2) — releases to PENDING.
    const firstClaim = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    const firstOutcome = await processExtractClaim(firstClaim!, deps);
    expect(firstOutcome.kind).toBe("retry");

    // Attempt 2: attempts now = maxAttempts — permanent failure. Use the
    // DATABASE's own now() here, not a JS Date — comparing a Node-clock
    // timestamp against Postgres's own `available_at <= now()` check is
    // exactly the skew-sensitive flake `test-support.ts` documents fixing.
    await db.update(batchQueueItems).set({ availableAt: sql`now()` }).where(eq(batchQueueItems.id, itemId));
    const secondClaim = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(secondClaim?.attempts).toBe(2);
    const secondOutcome = await processExtractClaim(secondClaim!, deps);
    expect(secondOutcome.kind).toBe("failed");

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, itemId));
    expect(item.status).toBe("FAILED");
    expect(item.lastError).toBeTruthy();

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.processedCount).toBe(1);
    expect(job.failedCount).toBe(1);
  });
});

describe("processExtractClaim — non-retryable failure", () => {
  it("a HaikuExtractionError fails the item immediately (first attempt), no retry", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "corrupt.jpg");
    const deps = makeDeps({ anthropicClient: clientThrowing(new HaikuExtractionError(["schema validation failed"])) });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("failed");

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("FAILED");
    expect(item.lastError).toMatch(/schema validation failed/);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.processedCount).toBe(1);
    expect(job.failedCount).toBe(1);
    expect(job.autoVerifiedCount).toBe(0);
  });

  it("rejects a malformed application record (missing net contents) rather than silently coercing it", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "malformed.jpg", { netContentsValue: null, netContentsUnit: null });
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("failed");
    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("FAILED");
  });
});

describe("processExtractClaim — lost-lease race (CP-3 §3.2)", () => {
  it("discards its own result when another worker already completed the item first — no duplicate verifications row, no double-counted batchJobs counters", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    // brandName/classType matching WELL_FORMED_EXTRACTION_BODY — this test
    // expects a clean PASS (autoVerifiedCount, not an escalation) so the
    // race is isolated to the claim/completion guard, not the router.
    const claimed = await claimedFixture(batchJobId, "lost-lease.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });

    // Simulate this worker's lease expiring WHILE it was still (slowly)
    // computing, and a second worker reclaiming + fully completing the
    // item first.
    await db.update(batchQueueItems).set({ leaseExpiresAt: await dbPastTimestamp(db, 1) }).where(eq(batchQueueItems.id, claimed.id));
    const secondClaim = await claimNextBatchQueueItem(db, "EXTRACT", "worker-2", 60, { scopeToBatchJobId: batchJobId });
    const secondDeps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY), warningResult: { verdict: "MATCH" } });
    const secondOutcome = await processExtractClaim(secondClaim!, secondDeps);
    expect(secondOutcome.kind).toBe("done");

    // The FIRST (stale) worker's own, now-late result must be discarded.
    const staleDeps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY), warningResult: { verdict: "MATCH" } });
    const staleOutcome = await processExtractClaim(claimed, staleDeps);
    expect(staleOutcome.kind).toBe("stale");

    // Exactly ONE verifications row for this label, and counters reflect
    // exactly one completion, not two.
    const allVerifications = await db.select().from(verifications).where(eq(verifications.applicationId, claimed.applicationId as number));
    expect(allVerifications).toHaveLength(1);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.processedCount).toBe(1);
    expect(job.autoVerifiedCount).toBe(1);
  });
});

describe("processExtractClaim — misconfiguration fails loudly, not per-item", () => {
  it("throws immediately when comparators is missing, rather than marking the item FAILED", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "misconfigured.jpg");
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) });
    // @ts-expect-error — deliberately simulating a caller that forgot to
    // supply comparators, the exact misconfiguration this guard exists for.
    delete deps.comparators;

    await expect(processExtractClaim(claimed, deps)).rejects.toThrow(/comparators is required/);

    // The item must still be CLAIMED, not FAILED — a config bug is not a
    // per-item outcome; the pool operator needs to see this loudly, and a
    // corrected redeploy should still be able to claim and process it.
    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("CLAIMED");
  });
});
