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
import type Anthropic from "@anthropic-ai/sdk";
import { RateLimitError } from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db";
import { batchJobs, batchQueueItems, dailySpend, reviewQueue, verifications } from "../../lib/db/schema";
import { getTodaySpendUsd, reserveDailyBudget, SONNET_CALL_RESERVE_ESTIMATE_USD, settleBudgetReservation, type BudgetReservation } from "../budget/daily-budget";
import { readLabelImage } from "../storage/db-image-storage";
import { getDefaultResolverClient } from "../resolver";
import { makeExtraction } from "../router/test-support";
import { makeFlaggedFields, makeMockMessage, makeRouterResult, WELL_FORMED_RESOLVER_BODY } from "../resolver/test-support";
import { BUDGET_EXHAUSTED_RETRY_DELAY_MS, DEFAULT_BACKOFF_CONFIG } from "./backoff";
import { claimNextBatchQueueItem } from "./claim";
import { ESCALATION_CAP_EXCEEDED_SKIP_REASON, reserveSonnetCall } from "./escalation-cap";
import { processResolveClaim, type ResolveWorkerDeps } from "./resolve-worker";
import { buildResolverInputSnapshot } from "./resolver-snapshot";
import {
  cleanupBatchJobFixture,
  createApplicationAndSavedImageFixture,
  createBatchJobFixture,
  createVerificationFixture,
  dbPastTimestamp,
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

/** Same as `clientReturning`, but also exposes how many times
 * `messages.create` was actually invoked — for tests asserting Sonnet is
 * NEVER called (the cap-skip and malformed-snapshot paths) rather than only
 * checking the side effect a silent double-call could still produce. */
function countingClientReturning(body: unknown): { client: Anthropic; callCount: () => number } {
  let calls = 0;
  const client = fakeAnthropicClient(async () => {
    calls += 1;
    return makeMockMessage(JSON.stringify(body));
  });
  return { client, callCount: () => calls };
}

/**
 * TRO-566 finding 1 — a stand-in budget guard that always has room, the
 * same shadowing role `extract-worker.test.ts`'s own `alwaysReserveBudget`
 * plays: every test in this file that does NOT explicitly exercise the
 * budget wiring gets a deterministic default that touches no real
 * `daily_spend` row, rather than silently falling through to the REAL
 * DB-backed functions this worker's own production default
 * (`defaultDeps()` inside resolve-worker.ts) binds.
 */
async function alwaysReserveBudget(estimatedUsd: number): Promise<BudgetReservation> {
  return { reserved: true, reservedUsd: estimatedUsd, spentUsd: estimatedUsd, budgetUsd: 5 };
}
async function noopSettleBudget(): Promise<void> {}

function makeDeps(overrides: Partial<ResolveWorkerDeps> = {}): ResolveWorkerDeps {
  return {
    db,
    readLabelImage,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
    reserveBudget: alwaysReserveBudget,
    settleBudget: noopSettleBudget,
    ...overrides,
  };
}

/** A verification whose escalation snapshot matches `../resolver/test-support.ts`'s
 * own fixtures — guaranteed to pair with `WELL_FORMED_RESOLVER_BODY`. */
async function escalatedFixture(batchJobId: number, filename: string) {
  const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, filename);
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

    const capped = countingClientReturning(WELL_FORMED_RESOLVER_BODY); // must NEVER be called
    const deps = makeDeps({ anthropicClient: capped.client });
    const outcome = await processResolveClaim(claimed, deps);
    expect(outcome).toEqual({ kind: "done", outcome: "cap-skipped" });
    expect(capped.callCount()).toBe(0); // the cap guard must short-circuit BEFORE ever calling Sonnet

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
    const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, "flaky.jpg");
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

    // handleResolveFailure's own releaseForRetry pushed availableAt into the
    // future by the real backoff delay (CP-3 §5.2) — pull it into
    // Postgres's OWN past rather than sleeping for real (lessons.md #8),
    // then claim and process the SAME item a second time, this time letting
    // the call succeed. Proves the reservation on attempt one was not a
    // one-time fluke of "first attempt only" bookkeeping: a wholly separate
    // attempt reserves a wholly separate unit of budget.
    await db.update(batchQueueItems).set({ availableAt: await dbPastTimestamp(db, 1) }).where(eq(batchQueueItems.id, firstClaim!.id));
    const secondClaim = await claimNextBatchQueueItem(db, "RESOLVE", "worker-1", 120, { scopeToBatchJobId: batchJobId });
    expect(secondClaim).not.toBeNull();
    const secondDeps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) });
    const secondOutcome = await processResolveClaim(secondClaim!, secondDeps);
    expect(secondOutcome).toEqual({ kind: "done", outcome: "resolved" });

    const [jobAfterSecond] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(jobAfterSecond.sonnetCallCount).toBe(2); // a SEPARATE reservation for the second attempt, on top of the first
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
    await db.update(batchQueueItems).set({ leaseExpiresAt: await dbPastTimestamp(db, 1) }).where(eq(batchQueueItems.id, firstClaim.id));
    const secondClaim = await claimNextBatchQueueItem(db, "RESOLVE", "worker-2", 120, { scopeToBatchJobId: batchJobId });
    expect(secondClaim).not.toBeNull();
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

    await db.update(batchQueueItems).set({ leaseExpiresAt: await dbPastTimestamp(db, 1) }).where(eq(batchQueueItems.id, firstClaim.id));
    const secondClaim = await claimNextBatchQueueItem(db, "RESOLVE", "worker-2", 120, { scopeToBatchJobId: batchJobId });
    expect(secondClaim).not.toBeNull();

    // The cap was already exhausted before EITHER worker ran — neither
    // worker's own reservation attempt can succeed, so neither may ever
    // call Sonnet, not just the one that loses the review_queue race.
    const capA = countingClientReturning(WELL_FORMED_RESOLVER_BODY); // must NEVER be called
    const capB = countingClientReturning(WELL_FORMED_RESOLVER_BODY); // must NEVER be called
    const depsA = makeDeps({ anthropicClient: capA.client });
    const depsB = makeDeps({ anthropicClient: capB.client });
    const [outcomeA, outcomeB] = await Promise.all([processResolveClaim(firstClaim, depsA), processResolveClaim(secondClaim!, depsB)]);

    const queueRows = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].resolverSkipReason).toBe(ESCALATION_CAP_EXCEEDED_SKIP_REASON);

    const outcomes = [outcomeA.kind, outcomeB.kind].sort();
    expect(outcomes).toEqual(["done", "stale"]);
    expect(capA.callCount()).toBe(0);
    expect(capB.callCount()).toBe(0);

    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.resolvedBySonnetCount + job.needsHumanCount).toBe(1);
  });
});

describe("processResolveClaim — malformed snapshot (CP-3 §2.3 — reject, never guess)", () => {
  it("fails immediately on an unsupported schemaVersion, without ever reserving Sonnet budget", async () => {
    const batchJobId = await trackBatch({ totalCount: 4 });
    const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, "bad-snapshot.jpg");
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId, batchJobId);
    await enqueueResolveItemFixture(db, { batchJobId, verificationId, resolverInput: { schemaVersion: "2" } });
    const claimed = await claimNextBatchQueueItem(db, "RESOLVE", "worker-1", 120, { scopeToBatchJobId: batchJobId });

    const malformed = countingClientReturning(WELL_FORMED_RESOLVER_BODY); // must NEVER be called
    const deps = makeDeps({ anthropicClient: malformed.client });
    const outcome = await processResolveClaim(claimed!, deps);
    expect(outcome.kind).toBe("failed");
    expect(malformed.callCount()).toBe(0); // an unsupported schemaVersion must reject before ever spending a Sonnet call

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

// TRO-566 finding 1 — before this ticket, `processResolveClaim` never
// called `checkBudget`/`recordSpendUsd` at all. Every test above this
// point predates this ticket and needed zero changes — makeDeps()'s new
// `reserveBudget`/`settleBudget` defaults are always-allow stand-ins, the
// same shadowing role `extract-worker.test.ts`'s own equivalents play. The
// blocks below are the new coverage, using the REAL DB-backed functions
// against a private, far-future date this file owns exclusively.
describe("processResolveClaim — daily budget (TRO-566)", () => {
  const BUDGET_DAY = "2099-09-12";
  const BUDGET_NOW = new Date(`${BUDGET_DAY}T00:00:00Z`);

  afterEach(async () => {
    await db.delete(dailySpend).where(eq(dailySpend.spendDate, BUDGET_DAY));
    delete process.env.DAILY_BUDGET_USD;
  });

  it("refuses to call Sonnet once the budget is exhausted — releases the item to retry instead", async () => {
    process.env.DAILY_BUDGET_USD = "1";
    await db.insert(dailySpend).values({ spendDate: BUDGET_DAY, totalUsd: 1 }); // already at the cap

    const batchJobId = await trackBatch({ totalCount: 20 }); // escalation cap = 5, plenty of room
    const { claimed } = await escalatedFixture(batchJobId, "budget-exhausted.jpg");
    const capped = countingClientReturning(WELL_FORMED_RESOLVER_BODY); // must NEVER be called
    const deps = makeDeps({
      anthropicClient: capped.client,
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, BUDGET_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, BUDGET_NOW),
    });

    const outcome = await processResolveClaim(claimed, deps);
    expect(capped.callCount()).toBe(0);
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") throw new Error("unreachable");
    expect(outcome.isRateLimit).toBe(false);
    expect(outcome.isBudgetExhausted).toBe(true);
    expect(outcome.delayMs).toBeGreaterThanOrEqual(BUDGET_EXHAUSTED_RETRY_DELAY_MS);

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, claimed.id));
    expect(item.status).toBe("PENDING");
    // The ledger itself is untouched — the refusal reserved nothing.
    expect(await getTodaySpendUsd(db, BUDGET_NOW)).toBeCloseTo(1, 6);

    // Documented, accepted tradeoff (TRO-566): the escalation-cap
    // reservation runs BEFORE the dollar-budget check, so a budget-blocked
    // attempt still counts as one escalation-cap attempt — see
    // resolve-worker.ts's own comment on the ordering.
    const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(job.sonnetCallCount).toBe(1);
  });

  it("exhausting maxAttempts under a sustained budget exhaustion reaches FAILED with a clear, distinct last_error", async () => {
    process.env.DAILY_BUDGET_USD = "1";
    await db.insert(dailySpend).values({ spendDate: BUDGET_DAY, totalUsd: 1 });

    const batchJobId = await trackBatch({ totalCount: 20 });
    const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, batchJobId, "budget-exhaust-max.jpg");
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId, batchJobId);
    const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
    await enqueueResolveItemFixture(db, { batchJobId, verificationId, resolverInput: snapshot });

    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY),
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, BUDGET_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, BUDGET_NOW),
      backoffConfig: { ...DEFAULT_BACKOFF_CONFIG, maxAttempts: 2, baseDelayMs: 1 },
    });

    const firstClaim = await claimNextBatchQueueItem(db, "RESOLVE", "worker-1", 120, { scopeToBatchJobId: batchJobId });
    const firstOutcome = await processResolveClaim(firstClaim!, deps);
    expect(firstOutcome.kind).toBe("retry");

    await db.update(batchQueueItems).set({ availableAt: await dbPastTimestamp(db, 1) }).where(eq(batchQueueItems.id, firstClaim!.id));
    const secondClaim = await claimNextBatchQueueItem(db, "RESOLVE", "worker-1", 120, { scopeToBatchJobId: batchJobId });
    expect(secondClaim?.attempts).toBe(2);
    const secondOutcome = await processResolveClaim(secondClaim!, deps);
    expect(secondOutcome.kind).toBe("failed");

    const [item] = await db.select().from(batchQueueItems).where(eq(batchQueueItems.id, firstClaim!.id));
    expect(item.status).toBe("FAILED");
    expect(item.lastError).toMatch(/spending limit/i);
  });

  it("reserves BEFORE the Sonnet call and settles the REAL, measured cost after — writes an observed daily_spend row from a batch worker run", async () => {
    process.env.DAILY_BUDGET_USD = "5";
    const batchJobId = await trackBatch({ totalCount: 4 }); // cap = 1, plenty for one call
    const { claimed } = await escalatedFixture(batchJobId, "budget-real-spend.jpg");
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY),
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, BUDGET_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, BUDGET_NOW),
    });

    expect(await getTodaySpendUsd(db, BUDGET_NOW)).toBe(0);
    const outcome = await processResolveClaim(claimed, deps);
    expect(outcome).toEqual({ kind: "done", outcome: "resolved" });

    const finalSpend = await getTodaySpendUsd(db, BUDGET_NOW);
    expect(finalSpend).toBeGreaterThan(0);
    // The REAL settled cost, not the SONNET_CALL_RESERVE_ESTIMATE_USD
    // placeholder reserveDailyBudget held room for before the call.
    expect(finalSpend).toBeLessThan(SONNET_CALL_RESERVE_ESTIMATE_USD);
  });

  it("refunds the FULL reservation when this caller does not actually call Sonnet itself — reuses another caller's already-finished result", async () => {
    // The resolve-worker shape finding 1's own acceptance evidence names
    // explicitly: resolveEscalatedLabel's OWN internal reservation
    // (TRO-506/CP-3 §3.3) can mean a caller that reserved dollar budget
    // never actually touches the Anthropic client at all.
    process.env.DAILY_BUDGET_USD = "5";
    const batchJobId = await trackBatch({ totalCount: 4 });
    const { claimed } = await escalatedFixture(batchJobId, "budget-refund-reuse.jpg");
    const alreadyResolved = { outcome: "resolved" as const, fields: [], reviewQueueId: 999 };
    const settleCalls: Array<{ reservedUsd: number; realUsd: number }> = [];
    const deps = makeDeps({
      // Simulates resolveEscalatedLabel reusing another caller's result —
      // it never touches options.client at all.
      resolveEscalatedLabel: async () => alreadyResolved,
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, BUDGET_NOW),
      settleBudget: async (reservedUsd, realUsd) => {
        settleCalls.push({ reservedUsd, realUsd });
        await settleBudgetReservation(reservedUsd, realUsd, db, BUDGET_NOW);
      },
    });

    await processResolveClaim(claimed, deps);
    // Proves a REAL reservation genuinely happened and was genuinely
    // refunded — not merely that the final ledger reads 0, which would
    // ALSO be true if this worker never reserved anything at all.
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0].reservedUsd).toBeGreaterThan(0);
    expect(settleCalls[0].realUsd).toBe(0);
    expect(await getTodaySpendUsd(db, BUDGET_NOW)).toBe(0); // reserved, then fully refunded
  });

  it("the production default (`defaultDeps()`) really binds the real DB-backed reserve/settle AND the real shared anthropicClient — fails if either binding is lost", async () => {
    // See extract-worker.test.ts's matching test for the full story: an
    // earlier version of this test injected a FAKE anthropicClient, which
    // stayed green even with NO real anthropicClient binding in
    // defaultDeps() at all — a real, observed batch-worker run against the
    // live API is what actually caught the gap (TRO-566's own acceptance
    // evidence). This test spies on the SAME shared client
    // resolveEscalatedLabel actually falls back to, instead of injecting a
    // fake that would hide exactly this gap again.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${BUDGET_DAY}T12:00:00Z`));
    const createSpy = vi
      .spyOn(getDefaultResolverClient().messages, "create")
      .mockResolvedValue(makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)) as never);
    try {
      const batchJobId = await trackBatch({ totalCount: 4 });
      const { claimed } = await escalatedFixture(batchJobId, "budget-default-wiring.jpg");
      const deps: Partial<ResolveWorkerDeps> & Pick<ResolveWorkerDeps, "readLabelImage"> = {
        db,
        readLabelImage,
        backoffConfig: DEFAULT_BACKOFF_CONFIG,
        // anthropicClient/reserveBudget/settleBudget ALL deliberately
        // omitted — the real production shape.
      };

      const outcome = await processResolveClaim(claimed, deps);
      expect(outcome).toEqual({ kind: "done", outcome: "resolved" });
      expect(createSpy).toHaveBeenCalledTimes(1);

      const rows = await db.select({ totalUsd: dailySpend.totalUsd }).from(dailySpend).where(eq(dailySpend.spendDate, BUDGET_DAY));
      expect(rows).toHaveLength(1);
      // The row must carry the REAL, non-refunded cost — before the fix,
      // settleBudget always refunded the FULL reservation and this row
      // read exactly 0.
      expect(rows[0].totalUsd).toBeGreaterThan(0);
    } finally {
      createSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
