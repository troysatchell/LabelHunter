/**
 * `listUnresolvedReviewQueue` against a real Postgres database — this
 * worktree's own, via `.factory-env` (DATABASE_URL). Same no-mocking
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
import { listUnresolvedReviewQueue } from "./list";

interface FixtureOverrides {
  reason?: ReviewReason;
  brandName?: string;
  classType?: string;
  createdAt?: Date;
  disposed?: boolean;
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
      const items = await listUnresolvedReviewQueue(db);
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
      const items = await listUnresolvedReviewQueue(db);
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
      const items = await listUnresolvedReviewQueue(db);
      const relevantIds = items.map((row) => row.id).filter((id) => id === older.queueId || id === newer.queueId);
      expect(relevantIds).toEqual([older.queueId, newer.queueId]);
    } finally {
      await cleanup(older.applicationId);
      await cleanup(newer.applicationId);
    }
  });
});
