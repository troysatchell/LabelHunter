/**
 * The resolver's atomic reservation against a real Postgres database —
 * this worktree's own, via `.factory-env` (TRO-506 / TRO-512, CP-3 §3.3).
 *
 * No mocked database anywhere in this file. The whole claim under test is
 * that Postgres serializes one `INSERT ... ON CONFLICT` statement so two
 * concurrent callers cannot both call Sonnet; a fake database that returns
 * whatever the test tells it to would prove nothing about that.
 *
 * The Anthropic client IS faked (the unit suite never calls the real API,
 * PRD §6) — it counts its calls, which is the money this ticket is about.
 *
 * No test here sleeps for a fixed time and then asserts (standing rule 8).
 * The concurrency test blocks the fake model call on a promise the test
 * itself resolves, and every wait is on an observable event: a call
 * arriving, or a resolver promise settling.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db";
import { applications, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import { resolveEscalatedLabel, ResolverReservationTimeoutError } from "./index";
import { readReviewQueueReservation, releaseReviewQueueReservation, reserveReviewQueueEntry } from "./reservation";
import { makeMockMessage, makeResolverInput, WELL_FORMED_RESOLVER_BODY } from "./test-support";

/** A promise plus its own resolver — the "observable event" every wait in
 * this file is anchored to, instead of a timer. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function makeVerificationFixture() {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: "TRO-506 Test Fixture",
      classType: "Straight Bourbon Whiskey",
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();

  const [labelImage] = await db
    .insert(labelImages)
    .values({
      applicationId: application.id,
      storagePath: "test-fixtures/tro-506.jpg",
      originalFilename: "tro-506.jpg",
      widthPx: 1000,
      heightPx: 1200,
    })
    .returning();

  const [verification] = await db
    .insert(verifications)
    .values({
      applicationId: application.id,
      labelImageId: labelImage.id,
      verdict: "REVIEW",
      resolutionPath: "EXTRACTOR_RESOLVER",
    })
    .returning();

  return { applicationId: application.id, verificationId: verification.id };
}

async function cleanup(applicationId: number) {
  // Cascades to labelImages, verifications, and review_queue.
  await db.delete(applications).where(eq(applications.id, applicationId));
}

/** Fakes just the surface `resolveEscalatedLabel` uses, and counts calls.
 * `gate` blocks every call until the test releases it. */
function countingClient(gate?: Promise<void>) {
  const calls: number[] = [];
  const arrived = deferred();
  const client = {
    messages: {
      create: vi.fn(async () => {
        calls.push(Date.now());
        arrived.resolve();
        if (gate) await gate;
        return makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY));
      }),
    },
  } as unknown as Anthropic;
  return { client, calls, firstCallArrived: arrived.promise };
}

describe("resolveEscalatedLabel — the reservation stops a second Sonnet call (TRO-506)", () => {
  it("pays for exactly one Sonnet call when two callers race for one verification", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    const release = deferred();
    const { client, calls, firstCallArrived } = countingClient(release.promise);
    const input = makeResolverInput({ verificationId });

    try {
      // Caller A starts and reaches the model call — the reservation is
      // committed by the time the fake client reports it arrived.
      const callerA = resolveEscalatedLabel(input, { client, db, reservationPollIntervalMs: 10 });
      await firstCallArrived;

      // Caller B starts while A is mid-call. It must not buy a second
      // call; it must wait for A's result.
      const callerB = resolveEscalatedLabel(input, { client, db, reservationPollIntervalMs: 10, reservationWaitMs: 10_000 });

      release.resolve();
      const [resultA, resultB] = await Promise.all([callerA, callerB]);

      expect(calls).toHaveLength(1);
      expect(resultB.reviewQueueId).toBe(resultA.reviewQueueId);
      expect(resultB.outcome).toBe(resultA.outcome);

      // One row, carrying one resolution, with no reservation left behind.
      const rows = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resolverOutput).not.toBeNull();
      expect(rows[0]?.resolverReservedUntil).toBeNull();
      // The reservation carries the label's own headline reason, so the row
      // a reviewer sees says why this label escalated even while the model
      // call is still in flight.
      expect(rows[0]?.reason).toBe(input.router.headlineReason);
    } finally {
      release.resolve();
      await cleanup(applicationId);
    }
  });

  it("gives up with a named error, and no Sonnet call, when the holder never finishes", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    const { client, calls } = countingClient();
    try {
      // A reservation nobody will ever fill — the crashed-holder case.
      const held = await reserveReviewQueueEntry({ verificationId, reason: "WARNING_MISMATCH" }, db);
      expect(held.kind).toBe("reserved");

      await expect(
        resolveEscalatedLabel(makeResolverInput({ verificationId }), {
          client,
          db,
          reservationWaitMs: 30,
          reservationPollIntervalMs: 10,
        }),
      ).rejects.toBeInstanceOf(ResolverReservationTimeoutError);

      // The point of the whole ticket: the caller that could not get the
      // reservation never bought a second call.
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("reuses an existing resolution instead of calling Sonnet again", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    const first = countingClient();
    const second = countingClient();
    try {
      const original = await resolveEscalatedLabel(makeResolverInput({ verificationId }), { client: first.client, db });
      const retry = await resolveEscalatedLabel(makeResolverInput({ verificationId }), { client: second.client, db });

      expect(first.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(0);
      expect(retry.reviewQueueId).toBe(original.reviewQueueId);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("releases the reservation when the model call fails, so the next caller can take it", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    const failing = {
      messages: { create: vi.fn(async () => Promise.reject(new Error("Sonnet is unavailable"))) },
    } as unknown as Anthropic;
    const retry = countingClient();
    try {
      await expect(resolveEscalatedLabel(makeResolverInput({ verificationId }), { client: failing, db })).rejects.toThrow(/Sonnet is unavailable/);

      // Released, not left leased for the full two minutes.
      const afterFailure = await readReviewQueueReservation(verificationId, db);
      expect(afterFailure.kind).toBe("free");

      // A retry proceeds immediately — it does not wait out a lease held by
      // a caller that has already failed.
      const result = await resolveEscalatedLabel(makeResolverInput({ verificationId }), { client: retry.client, db, reservationWaitMs: 0 });
      expect(retry.calls).toHaveLength(1);
      expect(result.outcome).toBe("resolved");
    } finally {
      await cleanup(applicationId);
    }
  });

  it("fills in the verify route's own pre-filed row instead of adding a second one (TRO-511)", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    const { client } = countingClient();
    try {
      // What `app/api/verify/route.ts` writes at verify time: a bare row,
      // reason only, so a human sees "needs review" before Sonnet runs.
      const [preFiled] = await db
        .insert(reviewQueue)
        .values({ verificationId, reason: "WARNING_MISMATCH", resolverInput: { schemaVersion: 1 } })
        .returning({ id: reviewQueue.id });

      const result = await resolveEscalatedLabel(makeResolverInput({ verificationId }), { client, db });

      expect(result.reviewQueueId).toBe(preFiled.id);
      const rows = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, verificationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resolverOutput).not.toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });
});

describe("reserveReviewQueueEntry — real database", () => {
  it("reports the holder while a reservation is live, and hands it over once it expires", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      const first = await reserveReviewQueueEntry({ verificationId, reason: "AMBIGUOUS_ABV", leaseSeconds: 60 }, db);
      expect(first.kind).toBe("reserved");

      const second = await reserveReviewQueueEntry({ verificationId, reason: "AMBIGUOUS_ABV" }, db);
      expect(second.kind).toBe("held");

      // Expire the reservation the way real time would, then confirm a
      // later caller takes it over rather than waiting forever — CP-3 §3.3
      // names the abandoned reservation as this ticket's own question.
      await db
        .update(reviewQueue)
        .set({ resolverReservedUntil: new Date(Date.now() - 1_000) })
        .where(eq(reviewQueue.verificationId, verificationId));

      const takeover = await reserveReviewQueueEntry({ verificationId, reason: "AMBIGUOUS_ABV" }, db);
      expect(takeover.kind).toBe("reserved");
      if (first.kind === "reserved" && takeover.kind === "reserved") {
        expect(takeover.id).toBe(first.id);
      }
    } finally {
      await cleanup(applicationId);
    }
  });

  it("rejects a lease that would expire the instant it commits", async () => {
    await expect(reserveReviewQueueEntry({ verificationId: 1, reason: "AMBIGUOUS_ABV", leaseSeconds: 0 }, db)).rejects.toThrow(RangeError);
    await expect(reserveReviewQueueEntry({ verificationId: 1, reason: "AMBIGUOUS_ABV", leaseSeconds: Number.NaN }, db)).rejects.toThrow(RangeError);
  });

  it("refuses to reserve a verification a deliberate skip already finished", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      await db.insert(reviewQueue).values({ verificationId, reason: "AMBIGUOUS_ABV", resolverSkipReason: "escalation cap reached" });
      await expect(reserveReviewQueueEntry({ verificationId, reason: "AMBIGUOUS_ABV" }, db)).rejects.toThrow(/deliberately skipped/);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("releases only a row that is still unresolved", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    const { client } = countingClient();
    try {
      const reserved = await reserveReviewQueueEntry({ verificationId, reason: "WARNING_MISMATCH" }, db);
      expect(reserved.kind).toBe("reserved");
      if (reserved.kind !== "reserved") return;

      expect(await releaseReviewQueueReservation(reserved.id, db)).toBe(true);
      expect((await readReviewQueueReservation(verificationId, db)).kind).toBe("free");

      await resolveEscalatedLabel(makeResolverInput({ verificationId }), { client, db });
      // A resolved row is finished: a late release from a stale caller must
      // not touch it.
      expect(await releaseReviewQueueReservation(reserved.id, db)).toBe(false);
    } finally {
      await cleanup(applicationId);
    }
  });
});
