/**
 * `processSingleLabelResolveClaim` against a real Postgres database
 * (TRO-511). No live Anthropic call — the resolver's OWN
 * `resolveEscalatedLabel` (LH-014, already merged) runs for real against a
 * fake `messages.create`, same pattern `resolve-worker.test.ts` and
 * `resolver/index.test.ts` already use.
 *
 * The FIRST describe block below (“end to end”) is this ticket's own
 * regression test: it drives the REAL `handleVerifyRequest` route to
 * produce a REVIEW verdict — the exact code path CP-3 §9 found broken —
 * then runs this worker against the row IT wrote, and asserts
 * `review_queue.resolver_output` actually gets populated. Before TRO-511,
 * nothing in this codebase ever called `resolveEscalatedLabel` for a
 * single-label-originated row (only its own test files did) — this test
 * fails for exactly that reason against pre-TRO-511 code, not because of a
 * fixture or wiring mistake.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { RateLimitError } from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { reviewQueue } from "../../lib/db/schema";
import { handleVerifyRequest, type VerifyRouteDeps } from "../../app/api/verify/route";
import type { VerifySuccessResponse } from "../../app/api/verify/types";
import { extractLabel } from "../extractor";
import { makeMockMessage as makeExtractorMockMessage, WELL_FORMED_EXTRACTION_BODY } from "../extractor/test-support";
import { preprocessImage } from "../preprocessing";
import { productionComparators } from "../comparators";
import type { WarningComparatorResult } from "../router";
import type { CompareGovernmentWarningFromImageResult } from "../warning";
import { readLabelImage, saveLabelImage } from "../storage/db-image-storage";
import { buildResolverInputSnapshot } from "../batch-queue/resolver-snapshot";
import { DEFAULT_BACKOFF_CONFIG } from "../batch-queue/backoff";
import { makeFlaggedFields, makeMockMessage, makeRouterResult, WELL_FORMED_RESOLVER_BODY } from "../resolver/test-support";
import { makeExtraction } from "../router/test-support";
import { claimNextReviewQueueResolveItem } from "./claim";
import { processSingleLabelResolveClaim, type SingleLabelResolveWorkerDeps } from "./worker";
import {
  cleanupApplicationFixture,
  createApplicationAndImageFixture,
  createApplicationAndSavedImageFixture,
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

function makeDeps(overrides: Partial<SingleLabelResolveWorkerDeps> = {}): SingleLabelResolveWorkerDeps {
  return {
    db,
    readLabelImage,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
    ...overrides,
  };
}

describe("processSingleLabelResolveClaim — end to end, off the real verify route (TRO-511's own regression test)", () => {
  it("a REVIEW-verdict verify request writes a review_queue row with resolverOutput null; this worker then fills it in", async () => {
    async function makeJpeg(): Promise<Buffer> {
      return sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 180, g: 180, b: 180 } } }).jpeg().toBuffer();
    }
    async function warningNeedsReviewStub(): Promise<CompareGovernmentWarningFromImageResult> {
      const comparator: WarningComparatorResult = { verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH" };
      return { comparator, boldSignal: null };
    }
    const image = new File([(await makeJpeg()) as unknown as BlobPart], "front-label.jpg", { type: "image/jpeg" });
    const fd = new FormData();
    fd.set("image", image);
    fd.set("beverageType", "spirits");
    fd.set("brandName", "Old Tom Distillery");
    fd.set("classType", "Straight Bourbon Whiskey");
    fd.set("alcoholContentPercent", "45");
    fd.set("netContentsValue", "750");
    fd.set("netContentsUnit", "mL");

    const routeDeps: VerifyRouteDeps = {
      db,
      preprocessImage,
      extractLabel,
      compareGovernmentWarning: warningNeedsReviewStub,
      saveLabelImage,
      comparators: productionComparators,
      anthropicClient: fakeAnthropicClient(async () => makeExtractorMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY))),
    };
    const request = new Request("http://localhost/api/verify", { method: "POST", body: fd });
    const response = await handleVerifyRequest(request, routeDeps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);
    expect(body.labelVerdict).toBe("REVIEW");

    // Confirmed BEFORE this worker ever runs: the route's own bare row,
    // visible to a human immediately, resolverOutput still null.
    const beforeRows = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, body.verificationId));
    expect(beforeRows).toHaveLength(1); // exactly one row — review_queue_verification_id_unique's own guarantee
    const [before] = beforeRows;
    expect(before.resolverOutput).toBeNull();
    expect(before.resolverInput).not.toBeNull();

    // Now the trigger this ticket adds: claim the row and resolve it — off
    // the request path entirely, the same "background worker" PRD §3.6
    // names. WELL_FORMED_EXTRACTION_BODY's own government_warning value is
    // what actually got snapshotted, so the resolver body below only needs
    // to answer whatever flaggedFields the router actually flagged for
    // THIS extraction — read back from the snapshot itself rather than
    // assumed, so this test does not silently start asserting the wrong
    // thing if routeLabel's own flagging logic ever changes.
    const claimed = await claimNextReviewQueueResolveItem(db, "worker-1", 120, 5, { scopeToVerificationIds: [body.verificationId] });
    expect(claimed).not.toBeNull();
    const snapshot = claimed?.resolverInput as { flaggedFields: { field: string }[] };
    const resolverBody = {
      overall: "RESOLVED",
      fields: snapshot.flaggedFields.map((f) => ({
        field: f.field,
        // Every field in the RAW schema carries a disposition (response.ts's
        // own `ctx.enumOf(obj.disposition, ...)` requires it unconditionally)
        // even though it is discarded for a correction field
        // (alcohol_content/net_contents/government_warning) — see
        // `response.ts`'s own module comment.
        disposition: "RESOLVED_MATCH",
        corrected_value: "resolved by the test's fake Sonnet client",
        evidence: "resolved by the test's fake Sonnet client",
        reason: "Resolved for TRO-511's own end-to-end test.",
        confidence: 0.9,
      })),
    };
    const deps = makeDeps({ anthropicClient: clientReturning(resolverBody) });

    const outcome = await processSingleLabelResolveClaim(claimed!, deps);
    expect(outcome.kind).toBe("done");

    const afterRows = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, body.verificationId));
    expect(afterRows).toHaveLength(1); // still exactly one row — filled in, never a second one inserted
    const [after] = afterRows;
    expect(after.id).toBe(before.id); // the SAME row — filled in, not a second one
    expect(after.resolverOutput).not.toBeNull();
    expect(after.resolverSkipReason).toBeNull();
    expect(after.claimedBy).toBeNull(); // cleared on completion
    expect(after.claimToken).toBeNull();
  });
});

/** A verification whose escalation snapshot matches `../resolver/test-support.ts`'s
 * own fixtures — guaranteed to pair with `WELL_FORMED_RESOLVER_BODY`. Mirrors
 * `../batch-queue/resolve-worker.test.ts`'s own `escalatedFixture`, adapted
 * to a batch-less verification and a `review_queue`-based claim. */
async function escalatedFixture(filename: string) {
  const { applicationId, labelImageId } = await createApplicationAndSavedImageFixture(db, filename);
  createdApplicationIds.push(applicationId);
  const verificationId = await createVerificationFixture(db, applicationId, labelImageId);
  const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
  await enqueuePendingReviewQueueItemFixture(db, verificationId, { reason: "WARNING_MISMATCH", resolverInput: snapshot });
  const claimed = await claimNextReviewQueueResolveItem(db, "worker-1", 120, 5, { scopeToVerificationIds: [verificationId] });
  if (!claimed) throw new Error("test setup failed: claim returned null");
  return { claimed, applicationId, verificationId };
}

describe("processSingleLabelResolveClaim — resolved", () => {
  it("calls the real resolver, releases the claim, and returns done/resolved", async () => {
    const { claimed, verificationId } = await escalatedFixture("resolved.jpg");
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_RESOLVER_BODY) });

    const outcome = await processSingleLabelResolveClaim(claimed, deps);
    expect(outcome).toEqual({ kind: "done", outcome: "resolved" });

    const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(row.resolverOutput).not.toBeNull();
    expect(row.claimedBy).toBeNull();
    expect(row.claimToken).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
  });
});

describe("processSingleLabelResolveClaim — needs-human", () => {
  it("still completes DONE when the resolver cannot decide", async () => {
    const { claimed, verificationId } = await escalatedFixture("needs-human.jpg");
    const needsHumanBody = {
      overall: "NEEDS_HUMAN",
      fields: WELL_FORMED_RESOLVER_BODY.fields.map((f, i) => (i === 0 ? { ...f, disposition: "NEEDS_HUMAN", corrected_value: null } : f)),
    };
    const deps = makeDeps({ anthropicClient: clientReturning(needsHumanBody) });

    const outcome = await processSingleLabelResolveClaim(claimed, deps);
    expect(outcome).toEqual({ kind: "done", outcome: "needs-human" });

    const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect((row.resolverOutput as { outcome: string }).outcome).toBe("needs-human");
  });
});

describe("processSingleLabelResolveClaim — malformed resolver_input", () => {
  it("a wrong schemaVersion is a non-retryable failure — lastError set, no Sonnet call", async () => {
    const { applicationId, labelImageId } = await createApplicationAndImageFixture(db, "bad-snapshot.jpg");
    createdApplicationIds.push(applicationId);
    const verificationId = await createVerificationFixture(db, applicationId, labelImageId);
    await enqueuePendingReviewQueueItemFixture(db, verificationId, { resolverInput: { schemaVersion: "2" } });
    const claimed = await claimNextReviewQueueResolveItem(db, "worker-1", 120, 5, { scopeToVerificationIds: [verificationId] });
    expect(claimed).not.toBeNull();

    let called = false;
    const deps = makeDeps({ anthropicClient: fakeAnthropicClient(async () => { called = true; return makeMockMessage("{}"); }) });
    const outcome = await processSingleLabelResolveClaim(claimed!, deps);

    expect(outcome.kind).toBe("failed");
    expect(called).toBe(false);
    const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, claimed!.id));
    expect(row.lastError).toMatch(/schemaVersion/);
    expect(row.resolverOutput).toBeNull();
    expect(row.claimedBy).toBeNull(); // cleared even on permanent failure
    // Found in local review: a non-retryable failure can land here on
    // attempt 1, well under maxAttempts — markPermanentlyFailed must pin
    // attempts at maxAttempts itself, or the row stays claimable and the
    // SAME deterministic failure (a real Sonnet call, for a resolver-side
    // non-retryable error) repeats needlessly.
    expect(row.attempts).toBe(5); // pinned to backoffConfig.maxAttempts (5), not left at 1

    const reclaimed = await claimNextReviewQueueResolveItem(db, "worker-2", 120, 5, { scopeToVerificationIds: [verificationId] });
    expect(reclaimed).toBeNull(); // permanently parked — never claimable again
  });
});

describe("processSingleLabelResolveClaim — retryable failure (backoff)", () => {
  it("a rate-limit error releases the claim and pushes availableAt forward, without exhausting attempts", async () => {
    const { claimed, verificationId } = await escalatedFixture("rate-limited.jpg");
    const rateLimitError = Object.assign(Object.create(RateLimitError.prototype), {
      status: 429,
      headers: new Headers({ "retry-after": "1" }),
      message: "rate limited",
    });
    const deps = makeDeps({ anthropicClient: clientThrowing(rateLimitError) });

    const outcome = await processSingleLabelResolveClaim(claimed, deps);
    expect(outcome.kind).toBe("retry");
    if (outcome.kind === "retry") expect(outcome.isRateLimit).toBe(true);

    const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(row.claimedBy).toBeNull();
    expect(row.claimToken).toBeNull();
    expect(row.attempts).toBe(1); // incremented by the CLAIM, not by this failure
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());

    // And it is claimable again once available (simulate the wait — no
    // fixed sleep, lessons.md #8: push availableAt into the past directly).
    await db.update(reviewQueue).set({ availableAt: await dbPastTimestamp(db, 1) }).where(eq(reviewQueue.id, claimed.id));
    const reclaimed = await claimNextReviewQueueResolveItem(db, "worker-2", 120, 5, { scopeToVerificationIds: [verificationId] });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.attempts).toBe(2);
  });

  it("exhausting maxAttempts on retryable failures becomes a permanent failure with a descriptive lastError", async () => {
    const { claimed, verificationId } = await escalatedFixture("exhausted.jpg");
    // attempts is already 1 from the claim above; a backoffConfig with
    // maxAttempts: 1 means THIS attempt is already at the cap.
    const deps = makeDeps({
      anthropicClient: clientThrowing(new Error("connection reset")),
      backoffConfig: { ...DEFAULT_BACKOFF_CONFIG, maxAttempts: 1 },
    });

    const outcome = await processSingleLabelResolveClaim(claimed, deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toMatch(/connection reset/);

    const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(row.lastError).toMatch(/connection reset/);
    expect(row.resolverOutput).toBeNull();
    expect(row.attempts).toBe(1); // GREATEST(1, 1) — already at the cap, not lowered

    const reclaimed = await claimNextReviewQueueResolveItem(db, "worker-2", 120, 1, { scopeToVerificationIds: [verificationId] });
    expect(reclaimed).toBeNull();
  });
});

describe("processSingleLabelResolveClaim — stale claim episode", () => {
  it("returns 'stale' and writes nothing when this worker's claim_token no longer matches (lost a lease-expiry race)", async () => {
    const { claimed, verificationId } = await escalatedFixture("stale.jpg");

    // Simulate another worker reclaiming the row after this one's lease
    // expired — a FRESH claim_token that no longer matches `claimed`'s own.
    await db.update(reviewQueue).set({ leaseExpiresAt: await dbPastTimestamp(db, 1) }).where(eq(reviewQueue.id, claimed.id));
    const otherWorkerClaim = await claimNextReviewQueueResolveItem(db, "worker-B", 120, 5, { scopeToVerificationIds: [verificationId] });
    expect(otherWorkerClaim).not.toBeNull();
    expect(otherWorkerClaim?.claimToken).not.toBe(claimed.claimToken);

    // The ORIGINAL (now-stale) claim's own failure-handling must not
    // clobber worker B's live claim.
    const deps = makeDeps({ anthropicClient: clientThrowing(new Error("stale call finally errors")) });
    const outcome = await processSingleLabelResolveClaim(claimed, deps);
    expect(outcome.kind).toBe("stale");

    const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
    expect(row.claimToken).toBe(otherWorkerClaim?.claimToken); // untouched — still worker B's
    expect(row.claimedBy).toBe("worker-B");
  });
});
