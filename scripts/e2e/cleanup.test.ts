/**
 * The E2E suite's own cleanup (TRO-524), against a real Postgres database
 * — this worktree's own, via `.factory-env`. A mocked database would prove
 * only that a `DELETE` was composed, not that the cascade actually removes
 * the `review_queue` row this ticket exists to stop accumulating.
 *
 * This file lives under `scripts/`, which `vitest.config.ts`'s `include`
 * glob already collects, so the unit run executes it — the cleanup is
 * plain Node code, not a Playwright spec.
 */
import { eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/lib/db";
import { applications, labelImages, reviewQueue, verifications } from "../../src/lib/db/schema";
import { deleteE2ETaggedApplications, E2E_TAG_PREFIX } from "./cleanup";
import { uniqueTag } from "./fixtures";

async function makeApplicationWithUnresolvedQueueItem(brandName: string) {
  const [application] = await db
    .insert(applications)
    .values({ beverageType: "spirits", brandName, classType: "Straight Bourbon Whiskey", netContentsValue: 750, netContentsUnit: "mL" })
    .returning();
  const [labelImage] = await db
    .insert(labelImages)
    .values({ applicationId: application.id, storagePath: "test-fixtures/tro-524.jpg", originalFilename: "tro-524.jpg", widthPx: 1000, heightPx: 1200 })
    .returning();
  const [verification] = await db
    .insert(verifications)
    .values({ applicationId: application.id, labelImageId: labelImage.id, verdict: "REVIEW", resolutionPath: "EXTRACTOR_ONLY" })
    .returning();
  const [queueRow] = await db.insert(reviewQueue).values({ verificationId: verification.id, reason: "AMBIGUOUS_BRAND" }).returning();
  return { applicationId: application.id, queueId: queueRow.id };
}

describe("deleteE2ETaggedApplications", () => {
  it("agrees with the tag every E2E fixture actually uses", () => {
    // A drift guard: if `uniqueTag` ever stops using this prefix, the
    // cleanup would quietly delete nothing and the queue would fill again.
    expect(uniqueTag("cleanup")).toMatch(new RegExp(`^${E2E_TAG_PREFIX}`));
  });

  it("removes an E2E run's unresolved review-queue rows, and leaves everything else alone", async () => {
    // Setup runs inside the try, not before it. A failure while building the
    // second fixture used to leave the first one's rows behind for good —
    // the very accumulation TRO-524 exists to stop (CodeRabbit finding,
    // local review round 6). `created` records every application this test
    // actually made, so the finally deletes exactly those.
    const created: number[] = [];
    try {
      const tagged = await makeApplicationWithUnresolvedQueueItem(uniqueTag("cleanup-tagged"));
      created.push(tagged.applicationId);
      const untagged = await makeApplicationWithUnresolvedQueueItem("TRO-524 Keeper Fixture");
      created.push(untagged.applicationId);

      const removed = await deleteE2ETaggedApplications(db);
      expect(removed).toBeGreaterThanOrEqual(1);

      // The E2E-created tree is gone, review-queue row included — that row
      // is what counted toward the queue's own page ceiling.
      expect(await db.select().from(applications).where(eq(applications.id, tagged.applicationId))).toHaveLength(0);
      expect(await db.select().from(reviewQueue).where(eq(reviewQueue.id, tagged.queueId))).toHaveLength(0);

      // A row nobody tagged survives. The cleanup deletes what the suite
      // made, never "everything in the table".
      expect(await db.select().from(applications).where(eq(applications.id, untagged.applicationId))).toHaveLength(1);
      expect(await db.select().from(reviewQueue).where(eq(reviewQueue.id, untagged.queueId))).toHaveLength(1);

      // Nothing tagged is left anywhere, not just the row this test made.
      expect(await db.select().from(applications).where(like(applications.brandName, `${E2E_TAG_PREFIX}%`))).toHaveLength(0);
    } finally {
      for (const applicationId of created) {
        await db.delete(applications).where(eq(applications.id, applicationId));
      }
    }
  });
});
