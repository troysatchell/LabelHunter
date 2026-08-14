/**
 * `listUnresolvedReviewQueue` against a real Postgres database — your
 * own local one, via `.env.local` (DATABASE_URL). Same no-mocking
 * rationale as `src/server/resolver/queue.test.ts`: the point is to prove
 * the real query (and the partial index it is written to use,
 * `review_queue_unresolved_idx`) actually returns what a human reviewer
 * needs, not an assumption about how Drizzle would behave.
 *
 * IMPORTANT — this suite shares one worktree database with every other
 * `*.test.ts` file, and vitest may run test files concurrently. No
 * assertion below reads the WHOLE unresolved list as if it were the only
 * thing in the table (a sibling file's own fixture could be live at the
 * same instant) — every assertion filters the result down to the rows
 * THIS test just created, by id, the same discipline `queue.test.ts`
 * already uses.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { applications, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import type { ReviewReason } from "../../lib/db/enums";
import { decodeReviewQueueCursor } from "./cursor";
import { listUnresolvedReviewQueue } from "./list";

interface FixtureOverrides {
  reason?: ReviewReason;
  brandName?: string;
  classType?: string;
  createdAt?: Date;
  disposed?: boolean;
  /** TRO-512: the resolver's own reservation window, or a deliberate skip
   * — the two states that must not look alike in the list. */
  resolverReservedUntil?: Date;
  resolverSkipReason?: string;
}

async function makeQueueItemFixture(overrides: FixtureOverrides = {}) {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: overrides.brandName ?? "TRO-476 Test Fixture",
      classType: overrides.classType ?? "Straight Bourbon Whiskey",
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();

  const [labelImage] = await db
    .insert(labelImages)
    .values({
      applicationId: application.id,
      storagePath: "test-fixtures/tro-476.jpg",
      originalFilename: "tro-476.jpg",
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
      resolutionPath: "EXTRACTOR_ONLY",
    })
    .returning();

  // A disposition and its timestamp are one fact recorded in two columns
  // (schema.ts's own CHECK constraint) — the fixture sets both together or
  // neither, never one alone.
  const [queueRow] = await db
    .insert(reviewQueue)
    .values({
      verificationId: verification.id,
      reason: overrides.reason ?? "AMBIGUOUS_BRAND",
      createdAt: overrides.createdAt,
      resolverReservedUntil: overrides.resolverReservedUntil,
      resolverSkipReason: overrides.resolverSkipReason,
      ...(overrides.disposed ? { disposition: "APPROVED" as const, disposedAt: new Date() } : {}),
    })
    .returning();

  return { applicationId: application.id, verificationId: verification.id, queueId: queueRow.id };
}

async function cleanup(applicationId: number) {
  // Cascades to labelImages, verifications, and reviewQueue.
  await db.delete(applications).where(eq(applications.id, applicationId));
}

describe("listUnresolvedReviewQueue — real database", () => {
  it("returns an unresolved item with its reason and brief application context", async () => {
    const { applicationId, verificationId, queueId } = await makeQueueItemFixture({
      reason: "AMBIGUOUS_ABV",
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
    });
    try {
      const { items } = await listUnresolvedReviewQueue(db);
      const item = items.find((row) => row.id === queueId);
      expect(item).toBeDefined();
      expect(item?.verificationId).toBe(verificationId);
      expect(item?.applicationId).toBe(applicationId);
      expect(item?.reason).toBe("AMBIGUOUS_ABV");
      expect(item?.brandName).toBe("Old Tom Distillery");
      expect(item?.classType).toBe("Straight Bourbon Whiskey");
      expect(item?.beverageType).toBe("spirits");
      expect(item?.labelVerdict).toBe("REVIEW");
      // Never a bare confidence percentage anywhere (TH-R20) — the reason
      // text is a full sentence, not a number.
      expect(item?.reasonText).toBe("A reviewer must check the alcohol content against the label.");
    } finally {
      await cleanup(applicationId);
    }
  });

  it("excludes an item once it has a disposition", async () => {
    const unresolved = await makeQueueItemFixture({ reason: "AMBIGUOUS_BRAND" });
    const disposed = await makeQueueItemFixture({ reason: "AMBIGUOUS_BRAND", disposed: true });
    try {
      const { items } = await listUnresolvedReviewQueue(db);
      const ids = items.map((row) => row.id);
      expect(ids).toContain(unresolved.queueId);
      expect(ids).not.toContain(disposed.queueId);
    } finally {
      await cleanup(unresolved.applicationId);
      await cleanup(disposed.applicationId);
    }
  });

  it("orders unresolved items oldest first — the partial index's own sort column", async () => {
    const older = await makeQueueItemFixture({ createdAt: new Date(Date.now() - 60_000) });
    const newer = await makeQueueItemFixture({ createdAt: new Date() });
    try {
      const { items } = await listUnresolvedReviewQueue(db);
      const relevantIds = items.map((row) => row.id).filter((id) => id === older.queueId || id === newer.queueId);
      expect(relevantIds).toEqual([older.queueId, newer.queueId]);
    } finally {
      await cleanup(older.applicationId);
      await cleanup(newer.applicationId);
    }
  });

  it("breaks a createdAt tie deterministically by id — CodeRabbit local review round 1", async () => {
    // Not necessarily "red before this fix": with no concurrent writers, a
    // small freshly-inserted set can happen to come back in insertion
    // order even with no explicit tiebreaker. What this test actually
    // proves is that the current query, with the id tiebreaker in place,
    // is deterministic — not that the old query was ever observed to
    // return the wrong order.
    const sharedTime = new Date();
    const first = await makeQueueItemFixture({ createdAt: sharedTime });
    const second = await makeQueueItemFixture({ createdAt: sharedTime });
    try {
      const { items } = await listUnresolvedReviewQueue(db);
      const relevantIds = items.map((row) => row.id).filter((id) => id === first.queueId || id === second.queueId);
      expect(relevantIds).toEqual([first.queueId, second.queueId]);
    } finally {
      await cleanup(first.applicationId);
      await cleanup(second.applicationId);
    }
  });

  it("bounds the result to the given limit, keeping the oldest rows — CodeRabbit local review round 1", async () => {
    // Anchored at the Unix epoch — guaranteed older than anything a
    // concurrently running test file could insert (those use "now" or
    // "60s ago"), so these two rows are always the globally oldest. That
    // makes an exact-length assertion safe even though this suite shares
    // one database with every other *.test.ts file.
    const oldest = await makeQueueItemFixture({ createdAt: new Date(0) });
    const secondOldest = await makeQueueItemFixture({ createdAt: new Date(1) });
    try {
      const { items } = await listUnresolvedReviewQueue(db, { limit: 1 });
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe(oldest.queueId);
    } finally {
      await cleanup(oldest.applicationId);
      await cleanup(secondOldest.applicationId);
    }
  });

  it.each([0, -1, 1.5, 101, Number.NaN])(
    "rejects a limit of %s rather than passing it through to .limit() — CodeRabbit local review round 2",
    async (limit) => {
      await expect(listUnresolvedReviewQueue(db, { limit })).rejects.toThrow(RangeError);
    },
  );
});

describe("listUnresolvedReviewQueue — paging past the first page (TRO-507)", () => {
  it("reports a nextCursor when more items follow, and reads the next page from it", async () => {
    // Anchored at the Unix epoch, like the limit test above: these three
    // rows are always the globally oldest, so page boundaries are exact
    // even while a sibling test file writes to the same database.
    const first = await makeQueueItemFixture({ createdAt: new Date(0) });
    const second = await makeQueueItemFixture({ createdAt: new Date(1) });
    const third = await makeQueueItemFixture({ createdAt: new Date(2) });
    try {
      const pageOne = await listUnresolvedReviewQueue(db, { limit: 2 });
      expect(pageOne.items.map((row) => row.id)).toEqual([first.queueId, second.queueId]);
      // The old behavior this ticket fixes: the list stopped here and said
      // nothing about the items it was hiding.
      expect(pageOne.nextCursor).not.toBeNull();

      const pageTwo = await listUnresolvedReviewQueue(db, {
        limit: 2,
        after: decodeReviewQueueCursor(pageOne.nextCursor ?? ""),
      });
      expect(pageTwo.items.map((row) => row.id)).toContain(third.queueId);
      // No item appears on both pages — the whole point of a keyset cursor.
      expect(pageTwo.items.map((row) => row.id)).not.toContain(second.queueId);
    } finally {
      await cleanup(first.applicationId);
      await cleanup(second.applicationId);
      await cleanup(third.applicationId);
    }
  });

  it("reports nextCursor as null on the last page", async () => {
    const only = await makeQueueItemFixture({ createdAt: new Date(0) });
    try {
      // A page large enough to hold every unresolved row this database can
      // plausibly hold during a test run ends the queue.
      const page = await listUnresolvedReviewQueue(db, { limit: 100 });
      if (page.nextCursor === null) {
        expect(page.items.map((row) => row.id)).toContain(only.queueId);
      } else {
        // A sibling test file filled the first page. Walk to the end and
        // prove the walk terminates with a null cursor rather than looping.
        let cursor: string | null = page.nextCursor;
        let pages = 0;
        while (cursor !== null && pages < 20) {
          const next: Awaited<ReturnType<typeof listUnresolvedReviewQueue>> = await listUnresolvedReviewQueue(db, {
            limit: 100,
            after: decodeReviewQueueCursor(cursor),
          });
          cursor = next.nextCursor;
          pages += 1;
        }
        expect(cursor).toBeNull();
      }
    } finally {
      await cleanup(only.applicationId);
    }
  });

  it("survives a cursor whose row was disposed of between pages", async () => {
    // A reviewer approving an item is the ordinary case, not an anomaly: a
    // keyset cursor names a POSITION, so the page after it is still well
    // defined once the row itself leaves the unresolved set.
    const first = await makeQueueItemFixture({ createdAt: new Date(0) });
    const second = await makeQueueItemFixture({ createdAt: new Date(1) });
    try {
      const pageOne = await listUnresolvedReviewQueue(db, { limit: 1 });
      expect(pageOne.items[0]?.id).toBe(first.queueId);
      const cursor = decodeReviewQueueCursor(pageOne.nextCursor ?? "");

      await db
        .update(reviewQueue)
        .set({ disposition: "APPROVED", disposedAt: new Date() })
        .where(eq(reviewQueue.id, first.queueId));

      const pageTwo = await listUnresolvedReviewQueue(db, { limit: 1, after: cursor });
      expect(pageTwo.items[0]?.id).toBe(second.queueId);
    } finally {
      await cleanup(first.applicationId);
      await cleanup(second.applicationId);
    }
  });
});

describe("listUnresolvedReviewQueue — what the resolver has done (TRO-512)", () => {
  it("tells a live reservation apart from a deliberate skip", async () => {
    // An anchor row created first, then read as a cursor: the page below
    // starts immediately before these four fixtures, so sibling rows made
    // by another test file cannot fill the first page and hide them
    // (CodeRabbit finding, local review round 6). The four fixtures keep
    // their default `createdAt`, so they still sort after the anchor.
    const anchor = await makeQueueItemFixture();
    const checking = await makeQueueItemFixture({ resolverReservedUntil: new Date(Date.now() + 60_000) });
    const skipped = await makeQueueItemFixture({ resolverSkipReason: "escalation cap reached" });
    const waiting = await makeQueueItemFixture();
    const expired = await makeQueueItemFixture({ resolverReservedUntil: new Date(Date.now() - 60_000) });
    try {
      const [anchorRow] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, anchor.queueId));
      const { items } = await listUnresolvedReviewQueue(db, { after: { createdAt: anchorRow.createdAt, id: anchorRow.id } });
      const statusOf = (id: number) => items.find((row) => row.id === id)?.resolverStatus;

      // CP-3 §3.3's exact hazard: without this, a reserved row and a
      // capped row both read as "no suggestion" and a reviewer cannot tell
      // "wait a moment" from "nothing is coming."
      expect(statusOf(checking.queueId)).toBe("checking");
      expect(statusOf(skipped.queueId)).toBe("skipped");
      expect(statusOf(waiting.queueId)).toBe("waiting");
      // An abandoned reservation is not "checking" — nobody is checking.
      expect(statusOf(expired.queueId)).toBe("waiting");
    } finally {
      await cleanup(anchor.applicationId);
      await cleanup(checking.applicationId);
      await cleanup(skipped.applicationId);
      await cleanup(waiting.applicationId);
      await cleanup(expired.applicationId);
    }
  });
});
