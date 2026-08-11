/**
 * Shared fixture helpers for the review-queue route tests (TRO-476) — both
 * `route.test.ts` and `[reviewQueueId]/route.test.ts` built one review-queue
 * item the same way; this module is the one place that setup and its
 * cleanup live now, so a schema change only needs updating once (CodeRabbit
 * finding, PR #16 review round 2).
 */
import { eq } from "drizzle-orm";
import { db } from "../../../lib/db";
import { applications, labelImages, reviewQueue, verifications } from "../../../lib/db/schema";

export async function makeQueueItemFixture(disposed = false) {
  const [application] = await db
    .insert(applications)
    .values({ beverageType: "spirits", brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey", netContentsValue: 750, netContentsUnit: "mL" })
    .returning();
  const [labelImage] = await db
    .insert(labelImages)
    .values({ applicationId: application.id, storagePath: "test-fixtures/tro-476.jpg", originalFilename: "tro-476.jpg", widthPx: 1000, heightPx: 1200 })
    .returning();
  const [verification] = await db
    .insert(verifications)
    .values({ applicationId: application.id, labelImageId: labelImage.id, verdict: "REVIEW", resolutionPath: "EXTRACTOR_ONLY" })
    .returning();
  const [queueRow] = await db
    .insert(reviewQueue)
    .values({
      verificationId: verification.id,
      reason: "AMBIGUOUS_BRAND",
      ...(disposed ? { disposition: "APPROVED" as const, disposedAt: new Date() } : {}),
    })
    .returning();
  return { applicationId: application.id, queueId: queueRow.id };
}

export async function cleanup(applicationId: number) {
  await db.delete(applications).where(eq(applications.id, applicationId));
}
