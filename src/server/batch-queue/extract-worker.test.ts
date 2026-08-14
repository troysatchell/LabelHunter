/**
 * `processExtractClaim` against a real Postgres database (LH-041 / TRO-474,
 * CP-3 §2.4, §7.1, §8). No live Anthropic call — every extractor response
 * is a canned `makeMockMessage`, the same pattern
 * `src/app/api/verify/route.test.ts` already uses.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db";
import { batchJobs, batchQueueItems, dailySpend, fieldResults, reviewQueue, verifications } from "../../lib/db/schema";
import { productionComparators } from "../comparators";
import { getTodaySpendUsd, HAIKU_CALL_RESERVE_ESTIMATE_USD, reserveDailyBudget, settleBudgetReservation, type BudgetReservation } from "../budget/daily-budget";
import { getDefaultExtractorClient, HaikuExtractionError } from "../extractor";
import { makeMockMessage, WELL_FORMED_EXTRACTION_BODY } from "../extractor/test-support";
import type { WarningComparatorResult } from "../router";
import type { BoldSignalResult, CompareGovernmentWarningFromImageInput, CompareGovernmentWarningFromImageResult } from "../warning";
import { readLabelImage } from "../storage/db-image-storage";
import { claimNextBatchQueueItem } from "./claim";
import { BUDGET_EXHAUSTED_RETRY_DELAY_MS, DEFAULT_BACKOFF_CONFIG } from "./backoff";
import { processExtractClaim, type ExtractWorkerDeps } from "./extract-worker";
import { resizeStoredOriginalToHaikuVariant } from "./image";
import { parseResolverInputSnapshot } from "./resolver-snapshot";
import {
  cleanupBatchJobFixture,
  createApplicationAndSavedImageFixture,
  createBatchJobFixture,
  dbPastTimestamp,
  enqueueExtractItemFixture,
  makeTestJpeg,
} from "./test-support";

const createdBatchJobIds: number[] = [];

afterEach(async () => {
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

/**
 * `government_warning` is out of scope for most of this file's tests —
 * they exercise the claim/completion-guard SQL and the cascade's other
 * four fields (LH-041/TRO-474), not the warning subsystem itself (LH-020,
 * wired into this worker by TRO-517). This stub keeps every other test's
 * warning field a stable NEEDS_REVIEW/WARNING_MISMATCH row: never MATCH,
 * never MISMATCH, so it can never silently flip an unrelated test's
 * verdict into PASS or FAIL behind that test's back. Mirrors
 * `src/app/api/verify/route.test.ts`'s own `warningNeedsReviewStub`
 * exactly (TRO-514's precedent). The "government warning wiring" describe
 * block below overrides `compareGovernmentWarning` explicitly to exercise
 * the real MATCH/MISMATCH/failure behavior.
 */
/** TRO-533 — every fake `compareGovernmentWarning` in this file returns
 * `{ comparator, boldSignal }` now, mirroring
 * `src/app/api/verify/route.test.ts`'s own `warningOutcome` helper
 * exactly. `boldSignal` defaults to `null` — fine for every test that is
 * not itself testing the bold-signal wiring. */
function warningOutcome(
  comparator: WarningComparatorResult,
  boldSignal: BoldSignalResult | null = null,
): CompareGovernmentWarningFromImageResult {
  return { comparator, boldSignal };
}

async function warningNeedsReviewStub(): Promise<CompareGovernmentWarningFromImageResult> {
  return warningOutcome({ verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH" });
}

/**
 * TRO-566 finding 1 — a stand-in budget guard that always has room,
 * mirroring `warningNeedsReviewStub`'s own role above: every test in this
 * file that does NOT explicitly exercise the budget wiring gets a
 * deterministic, always-allow default that touches no real `daily_spend`
 * row, rather than silently falling through to the REAL DB-backed
 * `reserveDailyBudget`/`settleBudgetReservation` this worker's own
 * production default (`defaultDeps()` inside extract-worker.ts) binds. The
 * "daily budget (TRO-566)" describe block below overrides these
 * explicitly to exercise the real thing.
 */
async function alwaysReserveBudget(estimatedUsd: number): Promise<BudgetReservation> {
  return { reserved: true, reservedUsd: estimatedUsd, spentUsd: estimatedUsd, budgetUsd: 5 };
}
async function noopSettleBudget(): Promise<void> {}

function makeDeps(overrides: Partial<ExtractWorkerDeps> = {}): ExtractWorkerDeps {
  return {
    db,
    comparators: productionComparators,
    readLabelImage,
    compareGovernmentWarning: warningNeedsReviewStub,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
    reserveBudget: alwaysReserveBudget,
    settleBudget: noopSettleBudget,
    ...overrides,
  };
}

async function claimedFixture(batchJobId: number, filename: string, applicationOverrides?: Parameters<typeof createApplicationAndSavedImageFixture>[3]) {
  const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, filename, applicationOverrides);
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
      // TRO-517's own "government warning wiring" describe block below
      // covers the real MATCH/MISMATCH/failure behavior in isolation —
      // this fake just needs a clean MATCH so this test's PASS verdict
      // isolates the claim/completion-guard mechanics it actually means to
      // exercise.
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }),
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
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }),
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
    // makeDeps()'s default compareGovernmentWarning (warningNeedsReviewStub)
    // is a deliberately neutral NEEDS_REVIEW/WARNING_MISMATCH stub — not
    // evidence the wiring is missing. TRO-517 wired the real comparator in;
    // see the "government warning wiring" describe block below for its
    // dedicated MATCH/MISMATCH/failure coverage. This test's own focus
    // stays the escalation/snapshot mechanics, unchanged.
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
    const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, "exhaust.jpg");
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
    const secondDeps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY), compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }) });
    const secondOutcome = await processExtractClaim(secondClaim!, secondDeps);
    expect(secondOutcome.kind).toBe("done");

    // The FIRST (stale) worker's own, now-late result must be discarded.
    const staleDeps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY), compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }) });
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

describe("processExtractClaim — government warning wiring (TRO-517, TH-R9)", () => {
  it("starts the warning comparator before the Haiku extraction call resolves (PRD §3.8 / CP-2 §4.4 — concurrent, not serial)", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "concurrency.jpg");

    const callOrder: string[] = [];
    let releaseExtraction!: () => void;
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });

    // The real `extractLabel` (this worker's default), fed by a fake
    // Anthropic client whose response stays pending until this test
    // releases it — the same `fakeAnthropicClient` helper every other test
    // in this file uses, just deliberately held open here.
    const anthropicClient = fakeAnthropicClient(async () => {
      callOrder.push("extractLabel:called");
      await extractionGate;
      callOrder.push("extractLabel:resolved");
      return makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY));
    });

    let markWarningCalled!: () => void;
    const warningCalled = new Promise<void>((resolve) => {
      markWarningCalled = resolve;
    });
    const compareGovernmentWarning: ExtractWorkerDeps["compareGovernmentWarning"] = async () => {
      callOrder.push("compareGovernmentWarning:called");
      // The concurrency requirement itself: this must run BEFORE
      // extractLabel's own promise has resolved, never after. Written as
      // an assertion here (not just below) so a serial implementation
      // fails inside the very call this test is timing, not only via the
      // `warningCalled` promise never settling.
      expect(callOrder).not.toContain("extractLabel:resolved");
      markWarningCalled();
      return warningOutcome({ verdict: "MATCH" });
    };

    const deps = makeDeps({ anthropicClient, compareGovernmentWarning });
    const outcomePromise = processExtractClaim(claimed, deps);

    // Observable event, not a sleep (standing rule 8): waits only until the
    // comparator has actually been invoked. Under serial code (`await
    // extractLabel(...)` before calling the warning comparator), this
    // promise never resolves — extractLabel is held open by
    // `extractionGate`, and nothing has released it yet — so the test
    // times out instead of passing, which is still a correct "fails for
    // the right reason" outcome for a concurrency regression.
    await warningCalled;
    expect(callOrder).toContain("compareGovernmentWarning:called");
    expect(callOrder).not.toContain("extractLabel:resolved");

    releaseExtraction();
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("done");
    expect(callOrder).toContain("extractLabel:resolved");
  });

  it("a compliant warning (MATCH) contributes to a clean PASS label verdict", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    // brandName/classType explicitly matching WELL_FORMED_EXTRACTION_BODY —
    // needed for a real comparator MATCH on every other field, isolating
    // the warning comparator's own MATCH as the thing this test proves
    // rolls up to a clean label PASS.
    const claimed = await claimedFixture(batchJobId, "warning-match.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH", note: "Government Warning matches the required text." }),
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("PASS");
    expect(outcome.escalated).toBe(false);

    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    const warningRow = persistedFields.find((row) => row.fieldName === "GOVERNMENT_WARNING");
    expect(warningRow?.verdict).toBe("MATCH");
  });

  it("a non-compliant warning (MISMATCH) contributes a FAIL label verdict", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "warning-mismatch.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MISMATCH", note: "Government Warning wording differs from the required text." }),
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("FAIL");

    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    const warningRow = persistedFields.find((row) => row.fieldName === "GOVERNMENT_WARNING");
    expect(warningRow?.verdict).toBe("MISMATCH");
  });

  it("TRO-569 / INT-005: persists the bold advisory signal for a batch verification too, and a 'not-bold' signal now routes an otherwise-MATCH warning to REVIEW — same rule as verify/route.ts, never a silent PASS", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "warning-bold-signal.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
    const boldSignal: BoldSignalResult = {
      signal: "not-bold",
      reason: "the prefix's stroke width does not measure wider than the body's",
      ratio: 0.9,
      splitFraction: 0.49,
      prefixStrokeWidthPx: 2,
      bodyStrokeWidthPx: 2.2,
    };
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      // A "not-bold" signal alongside a compliant MATCH — proves the
      // signal is persisted AND that it degrades this field to review
      // (TRO-569), the same boundary route.test.ts proves for the
      // single-label path. Before TRO-569 this signal never changed a
      // verdict (TRO-533's original rule); TRO-569 supersedes that for
      // exactly this edge — see field-resolution.test.ts's own describe
      // block for the full set of untouched edges (bold, uncertain,
      // existing MISMATCH, never a hard FAIL).
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }, boldSignal),
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("REVIEW");
    expect(outcome.escalated).toBe(true);

    const [row] = await db.select().from(verifications).where(eq(verifications.id, outcome.verificationId));
    expect(row.boldSignal).toEqual(boldSignal);

    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    const warningRow = persistedFields.find((row) => row.fieldName === "GOVERNMENT_WARNING");
    expect(warningRow?.verdict).toBe("NEEDS_REVIEW");
    expect(warningRow?.reason).toBe("'GOVERNMENT WARNING' must print in bold type; the measured prefix is not bold.");
  });

  it("a 'not-bold' signal never touches an existing MISMATCH warning in the batch path either", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "warning-mismatch-not-bold.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
    const boldSignal: BoldSignalResult = {
      signal: "not-bold",
      reason: "the prefix's stroke width does not measure wider than the body's",
      ratio: 0.9,
      splitFraction: 0.49,
      prefixStrokeWidthPx: 2,
      bodyStrokeWidthPx: 2.2,
    };
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () =>
        warningOutcome({ verdict: "MISMATCH", note: "Government Warning wording differs from the required text." }, boldSignal),
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("FAIL");

    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    const warningRow = persistedFields.find((row) => row.fieldName === "GOVERNMENT_WARNING");
    expect(warningRow?.verdict).toBe("MISMATCH");
  });

  // The remaining cells the orchestrator's self-review round asked for: a
  // `bold` or `uncertain` signal alongside a MATCH still persists the full
  // signal but never touches the verdict — the degrade rule only fires on
  // `not-bold`. These pass immediately against the already-shipped code;
  // new coverage, not a red-first regression test.

  it("a 'bold' signal is persisted alongside a MATCH but never changes the verdict", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "warning-match-bold.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
    const boldSignal: BoldSignalResult = {
      signal: "bold",
      reason: "the prefix's stroke width measures wider than the body's",
      ratio: 2.1,
      splitFraction: 0.49,
      prefixStrokeWidthPx: 5,
      bodyStrokeWidthPx: 2.4,
    };
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }, boldSignal),
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("PASS");

    const [row] = await db.select().from(verifications).where(eq(verifications.id, outcome.verificationId));
    expect(row.boldSignal).toEqual(boldSignal);
    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    const warningRow = persistedFields.find((row) => row.fieldName === "GOVERNMENT_WARNING");
    expect(warningRow?.verdict).toBe("MATCH");
  });

  it("an 'uncertain' signal is persisted alongside a MATCH but never changes the verdict — never accuse on uncertainty", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "warning-match-uncertain.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
    const boldSignal: BoldSignalResult = {
      signal: "uncertain",
      reason: "prefix and body stroke-width ranges overlap; no clean separation",
      ratio: null,
      splitFraction: null,
      prefixStrokeWidthPx: null,
      bodyStrokeWidthPx: null,
    };
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }, boldSignal),
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("PASS");

    const [row] = await db.select().from(verifications).where(eq(verifications.id, outcome.verificationId));
    expect(row.boldSignal).toEqual(boldSignal);
    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    const warningRow = persistedFields.find((row) => row.fieldName === "GOVERNMENT_WARNING");
    expect(warningRow?.verdict).toBe("MATCH");
  });

  it("a warning-comparator promise rejection degrades that field to NEEDS_REVIEW instead of failing the item (CP-2 §4.4 rule 3)", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "warning-reject.jpg");
    let wasCalled = false;
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => {
        wasCalled = true;
        throw new Error("region-detect: sharp exploded");
      },
    });

    const outcome = await processExtractClaim(claimed, deps);
    // Proves the comparator actually ran and its rejection was caught —
    // not merely that the field happens to default to REVIEW some other
    // way (e.g. the dependency never being called at all).
    expect(wasCalled).toBe(true);
    // "done", never "retry"/"failed" — a warning-check failure degrades
    // the ONE field, it never fails the whole item.
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("REVIEW");
    expect(outcome.escalated).toBe(true);

    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    const warningRow = persistedFields.find((row) => row.fieldName === "GOVERNMENT_WARNING");
    expect(warningRow?.verdict).toBe("NEEDS_REVIEW");
  });

  it("a SYNCHRONOUS throw from the warning comparator also degrades gracefully, not just a rejected promise", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "warning-throw-sync.jpg");
    let wasCalled = false;
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: () => {
        wasCalled = true;
        throw new Error("boom, synchronously, before returning any promise at all");
      },
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(wasCalled).toBe(true);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.verdict).toBe("REVIEW");

    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, outcome.verificationId));
    const warningRow = persistedFields.find((row) => row.fieldName === "GOVERNMENT_WARNING");
    expect(warningRow?.verdict).toBe("NEEDS_REVIEW");
  });

  it("passes the ORIGINAL full-resolution image to the warning comparator, never the resized Haiku variant (CP-2 §8.3)", async () => {
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "warning-original-image.jpg");
    // Matches claimedFixture's/createApplicationAndSavedImageFixture's own
    // declared labelImages.widthPx/heightPx (1200x1600) — see this file's
    // fixture, and image.ts's own header comment on why the DB-declared
    // dimensions (not a re-measurement of the bytes) drive the resize.
    const originalBytes = await makeTestJpeg();

    let capturedOriginalImage: Buffer | undefined;
    const deps = makeDeps({
      readLabelImage: async () => originalBytes,
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async (input: CompareGovernmentWarningFromImageInput) => {
        capturedOriginalImage = input.originalImage;
        return warningOutcome({ verdict: "MATCH" });
      },
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");

    expect(capturedOriginalImage).toBeDefined();
    expect(capturedOriginalImage!.equals(originalBytes)).toBe(true);

    // Independent proof the two are genuinely different buffers, not the
    // same object compared to itself — resizeStoredOriginalToHaikuVariant
    // is the SAME real function extract-worker.ts itself calls, given the
    // same original bytes and the same declared dimensions.
    const haikuVariant = await resizeStoredOriginalToHaikuVariant(originalBytes, 1200, 1600);
    expect(capturedOriginalImage!.equals(haikuVariant.buffer)).toBe(false);
  });
});

// TRO-566 finding 1 — before this ticket, `processExtractClaim` never
// called `checkBudget`/`recordSpendUsd` at all (grep across
// `src/server/batch-queue/` returned zero hits). A batch admitted under
// budget could run past the daily cap once in flight. Every test above
// this point predates this ticket and needed zero changes — makeDeps()'s
// new `reserveBudget`/`settleBudget` defaults (`alwaysReserveBudget`/
// `noopSettleBudget`) are always-allow stand-ins, the same shadowing
// `compareGovernmentWarning`'s own default already uses. The blocks below
// are the new coverage, using the REAL DB-backed functions against a
// private, far-future date this file owns exclusively.
describe("processExtractClaim — daily budget (TRO-566)", () => {
  const BUDGET_DAY = "2099-09-11";
  const BUDGET_NOW = new Date(`${BUDGET_DAY}T00:00:00Z`);

  afterEach(async () => {
    await db.delete(dailySpend).where(eq(dailySpend.spendDate, BUDGET_DAY));
    delete process.env.DAILY_BUDGET_USD;
  });

  it("refuses to call the model once the budget is exhausted — releases the item to retry instead", async () => {
    process.env.DAILY_BUDGET_USD = "1";
    await db.insert(dailySpend).values({ spendDate: BUDGET_DAY, totalUsd: 1 }); // already at the cap

    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "budget-exhausted.jpg");
    let extractCalled = false;
    // Proves the refusal, not just the outcome shape: the Anthropic client
    // itself must never be called — same tracking shape this file's other
    // `extractCalled`-style tests already use.
    const deps = makeDeps({
      anthropicClient: fakeAnthropicClient(async () => {
        extractCalled = true;
        return makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY));
      }),
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, BUDGET_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, BUDGET_NOW),
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(extractCalled).toBe(false);
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") throw new Error("unreachable");
    expect(outcome.isRateLimit).toBe(false);
    expect(outcome.isBudgetExhausted).toBe(true);
    expect(outcome.delayMs).toBeGreaterThanOrEqual(BUDGET_EXHAUSTED_RETRY_DELAY_MS);

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("PENDING");

    // The refusal itself reserved nothing — the ledger is untouched.
    expect(await getTodaySpendUsd(db, BUDGET_NOW)).toBeCloseTo(1, 6);
  });

  it("exhausting maxAttempts under a sustained budget exhaustion reaches FAILED with a clear, distinct last_error", async () => {
    process.env.DAILY_BUDGET_USD = "1";
    await db.insert(dailySpend).values({ spendDate: BUDGET_DAY, totalUsd: 1 });

    const batchJobId = await trackBatch({ totalCount: 1 });
    const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, "budget-exhaust-max.jpg");
    const itemId = await enqueueExtractItemFixture(db, { batchJobId, applicationId, labelImageId });
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, BUDGET_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, BUDGET_NOW),
      backoffConfig: { ...DEFAULT_BACKOFF_CONFIG, maxAttempts: 2, baseDelayMs: 1 },
    });

    const firstClaim = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    const firstOutcome = await processExtractClaim(firstClaim!, deps);
    expect(firstOutcome.kind).toBe("retry");

    await db.update(batchQueueItems).set({ availableAt: sql`now()` }).where(eq(batchQueueItems.id, itemId));
    const secondClaim = await claimNextBatchQueueItem(db, "EXTRACT", "worker-1", 60, { scopeToBatchJobId: batchJobId });
    expect(secondClaim?.attempts).toBe(2);
    const secondOutcome = await processExtractClaim(secondClaim!, deps);
    expect(secondOutcome.kind).toBe("failed");

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, itemId));
    expect(item.status).toBe("FAILED");
    expect(item.lastError).toMatch(/spending limit/i);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.processedCount).toBe(1);
    expect(job.failedCount).toBe(1);
  });

  it("reserves BEFORE the Haiku call and settles the REAL, measured cost after — writes an observed daily_spend row from a batch worker run", async () => {
    process.env.DAILY_BUDGET_USD = "5";
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "budget-real-spend.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
    const deps = makeDeps({
      // makeMockMessage's own usage: 100 input tokens, 50 output tokens.
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }),
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, BUDGET_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, BUDGET_NOW),
    });

    expect(await getTodaySpendUsd(db, BUDGET_NOW)).toBe(0);
    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("done");

    // HAIKU_4_5_PRICING (scripts/eval/usage.ts): $1/MTok in, $5/MTok out.
    // 100 * (1/1_000_000) + 50 * (5/1_000_000) = 0.00035 — the REAL settled
    // cost, not the HAIKU_CALL_RESERVE_ESTIMATE_USD placeholder ($0.01)
    // reserveDailyBudget held room for before the call.
    const finalSpend = await getTodaySpendUsd(db, BUDGET_NOW);
    expect(finalSpend).toBeCloseTo(0.00035, 6);
    expect(finalSpend).toBeLessThan(HAIKU_CALL_RESERVE_ESTIMATE_USD);
  });

  it("refunds the FULL reservation when the Haiku call itself fails — no phantom charge for a call that never happened", async () => {
    process.env.DAILY_BUDGET_USD = "5";
    const batchJobId = await trackBatch({ totalCount: 1 });
    const claimed = await claimedFixture(batchJobId, "budget-refund-on-failure.jpg");
    const deps = makeDeps({
      anthropicClient: clientThrowing(new HaikuExtractionError(["schema validation failed"])),
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, BUDGET_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, BUDGET_NOW),
    });

    const outcome = await processExtractClaim(claimed, deps);
    expect(outcome.kind).toBe("failed"); // HaikuExtractionError is non-retryable

    expect(await getTodaySpendUsd(db, BUDGET_NOW)).toBe(0);
  });

  it("the production default (`defaultDeps()`) really binds the real DB-backed reserve/settle AND the real shared anthropicClient — fails if either binding is lost", async () => {
    // Mirrors src/app/api/verify/route.test.ts's own "records REAL spend
    // ... fails if defaultDeps loses anthropicClient" pattern (TRO-482
    // round 1's own lesson, hit again for real here: an earlier version of
    // this test injected a FAKE `anthropicClient`, which made it pass
    // even though defaultDeps() had NO real anthropicClient binding at
    // all — a real, observed batch-worker run against the live API is
    // what actually caught it, TRO-566's own acceptance evidence. Without
    // the binding, `d.anthropicClient` stays `undefined`,
    // `wrapAnthropicClientForUsageCapture(undefined)` wraps nothing,
    // `extractLabel` still calls the real API via its OWN shared default
    // client, but this worker's usage capture never sees that call — and
    // `settleBudget` always refunds the FULL reservation even after a
    // genuine, real-money call. This test spies on the SAME shared client
    // `extractLabel` actually falls back to, the same way the network
    // call is intercepted, rather than injecting a fake client that would
    // hide exactly this gap again.
    //
    // Every OTHER test in this file injects its own reserveBudget/
    // settleBudget/anthropicClient via makeDeps(), so none of them would
    // catch defaultDeps() silently losing any of these bindings. This
    // test supplies NONE of them, exercising extract-worker.ts's own
    // internal defaultDeps() exactly as scripts/batch-worker/run.ts does.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${BUDGET_DAY}T12:00:00Z`));
    const createSpy = vi
      .spyOn(getDefaultExtractorClient().messages, "create")
      // makeMockMessage's own usage: 100 input tokens, 50 output tokens.
      .mockResolvedValue(makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY)) as never);
    try {
      const batchJobId = await trackBatch({ totalCount: 1 });
      const claimed = await claimedFixture(batchJobId, "budget-default-wiring.jpg", { brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" });
      const deps: Partial<ExtractWorkerDeps> = {
        db,
        comparators: productionComparators,
        readLabelImage,
        compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }),
        backoffConfig: DEFAULT_BACKOFF_CONFIG,
        // anthropicClient/reserveBudget/settleBudget ALL deliberately
        // omitted — the real production shape.
      };

      const outcome = await processExtractClaim(claimed, deps);
      expect(outcome.kind).toBe("done");
      expect(createSpy).toHaveBeenCalledTimes(1);

      const rows = await db.select({ totalUsd: dailySpend.totalUsd }).from(dailySpend).where(eq(dailySpend.spendDate, BUDGET_DAY));
      expect(rows).toHaveLength(1);
      // The row must carry the REAL, non-refunded cost. Before the fix
      // (missing anthropicClient binding), settleBudget always refunded
      // the FULL reservation and this row read exactly 0.
      expect(rows[0].totalUsd).toBeGreaterThan(0);
      // HAIKU_4_5_PRICING (scripts/eval/usage.ts): $1/MTok in, $5/MTok
      // out. 100 * (1/1_000_000) + 50 * (5/1_000_000) = 0.00035.
      expect(rows[0].totalUsd).toBeCloseTo(0.00035, 6);
    } finally {
      createSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
