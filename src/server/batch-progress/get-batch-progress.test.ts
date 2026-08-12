/**
 * `getBatchProgress` against a real Postgres database (LH-042 / TRO-475).
 * Reads live from `batch_jobs`/`batch_queue_items`/`verifications` — this
 * suite proves that live read against fixture rows in every state the
 * ticket's four designed states, and CP-3 §7.1's decision table, describe.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { batchJobs, fieldResults, reviewQueue, verifications } from "../../lib/db/schema";
import { cleanupBatchJobFixture, createApplicationAndImageFixture, createBatchJobFixture, enqueueExtractItemFixture } from "../batch-queue/test-support";
import { getBatchProgress } from "./get-batch-progress";

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

describe("getBatchProgress", () => {
  it("returns found:false for a batch job that does not exist", async () => {
    const result = await getBatchProgress(db, 999_999_999);
    expect(result.found).toBe(false);
  });

  it("reads the summary counters straight off the batch_jobs row", async () => {
    const batchJobId = await trackBatch({ totalCount: 10 });
    await db
      .update(batchJobs)
      .set({ processedCount: 4, autoVerifiedCount: 3, resolvedBySonnetCount: 1, needsHumanCount: 0, failedCount: 0 })
      .where(eq(batchJobs.id, batchJobId));

    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.totalCount).toBe(10);
    expect(result.progress.processedCount).toBe(4);
    expect(result.progress.autoVerifiedCount).toBe(3);
    expect(result.progress.resolvedBySonnetCount).toBe(1);
  });

  it("computes passCount/failCount from verifications.verdict, independent of autoVerifiedCount (CP-3 §7.1)", async () => {
    const batchJobId = await trackBatch();
    const a = await createApplicationAndImageFixture(db, batchJobId, "pass.jpg");
    const b = await createApplicationAndImageFixture(db, batchJobId, "fail.jpg");
    await db.insert(verifications).values({ applicationId: a.applicationId, labelImageId: a.labelImageId, batchJobId, verdict: "PASS", resolutionPath: "EXTRACTOR_ONLY" });
    await db.insert(verifications).values({ applicationId: b.applicationId, labelImageId: b.labelImageId, batchJobId, verdict: "FAIL", resolutionPath: "EXTRACTOR_ONLY" });

    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.passCount).toBe(1);
    expect(result.progress.failCount).toBe(1);
  });

  it("returns latency: null when no label has finished the EXTRACT phase yet — never a fabricated number", async () => {
    const batchJobId = await trackBatch();
    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.latency).toBeNull();
  });

  it("returns throughput: null before the batch has completed — never a fabricated in-flight rate (TRO-544)", async () => {
    const batchJobId = await trackBatch({ totalCount: 10 });
    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.throughput).toBeNull();
  });

  it("computes items/minute and the per-item average from startedAt/completedAt once the batch is done (TRO-544, PRD §3.8)", async () => {
    const batchJobId = await trackBatch({ totalCount: 10 });
    // A deterministic 2-minute span, computed in Postgres's own clock — same
    // reasoning as the latency test just below: avoid Node/Postgres clock skew.
    await db.execute(
      sql`UPDATE batch_jobs SET started_at = now() - interval '2 minutes', completed_at = now(), status = 'COMPLETED' WHERE id = ${batchJobId}`,
    );

    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.throughput).not.toBeNull();
    expect(result.progress.throughput?.itemsPerMinute).toBeCloseTo(5, 0); // 10 items / 2 minutes
    expect(result.progress.throughput?.avgMsPerItem).toBeGreaterThan(0);
  });

  it("returns autoVerifiedShare: null before anything has processed — never a fabricated 0% (TRO-544)", async () => {
    const batchJobId = await trackBatch({ totalCount: 10 });
    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.autoVerifiedShare).toBeNull();
  });

  it("computes autoVerifiedShare from autoVerifiedCount/processedCount, live off batch_jobs (TRO-544, CP-1 §4.5 step 3)", async () => {
    const batchJobId = await trackBatch({ totalCount: 10 });
    await db.update(batchJobs).set({ processedCount: 8, autoVerifiedCount: 6 }).where(eq(batchJobs.id, batchJobId));

    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.autoVerifiedShare).toBe(0.75);
  });

  it("computes avg/p95 latency from DONE EXTRACT items' claimed_at→updated_at gap", async () => {
    const batchJobId = await trackBatch();
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const itemId = await enqueueExtractItemFixture(db, { batchJobId, applicationId: a.applicationId, labelImageId: a.labelImageId });
    // A deterministic ~5-second gap, computed entirely in Postgres's own
    // clock in one statement — avoids any Node/Postgres clock-skew risk
    // (the same reasoning `test-support.ts`'s own `dbPastTimestamp` states).
    await db.execute(sql`UPDATE batch_queue_items SET status = 'DONE', claimed_at = now() - interval '5 seconds', updated_at = now() WHERE id = ${itemId}`);

    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.latency).not.toBeNull();
    expect(result.progress.latency?.count).toBe(1);
    expect(result.progress.latency?.avgMs).toBeGreaterThan(4500);
    expect(result.progress.latency?.avgMs).toBeLessThan(5500);
  });

  it("reports rateLimitBackoff.active only when a PENDING item is genuinely waiting out a scheduled retry (attempts > 0, available_at in the future)", async () => {
    const batchJobId = await trackBatch();
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    const itemId = await enqueueExtractItemFixture(db, { batchJobId, applicationId: a.applicationId, labelImageId: a.labelImageId });

    const before = await getBatchProgress(db, batchJobId);
    expect(before.found).toBe(true);
    if (before.found) expect(before.progress.rateLimitBackoff.active).toBe(false);

    await db.execute(sql`UPDATE batch_queue_items SET attempts = 1, available_at = now() + interval '20 seconds' WHERE id = ${itemId}`);

    const after = await getBatchProgress(db, batchJobId);
    expect(after.found).toBe(true);
    if (!after.found) return;
    expect(after.progress.rateLimitBackoff.active).toBe(true);
    expect(after.progress.rateLimitBackoff.itemCount).toBe(1);
  });

  it("does not report rateLimitBackoff.active for a PENDING item with zero attempts (never claimed yet, not a retry)", async () => {
    const batchJobId = await trackBatch();
    const a = await createApplicationAndImageFixture(db, batchJobId, "a.jpg");
    await enqueueExtractItemFixture(db, { batchJobId, applicationId: a.applicationId, labelImageId: a.labelImageId });

    const result = await getBatchProgress(db, batchJobId);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.progress.rateLimitBackoff.active).toBe(false);
  });

  describe("results rows", () => {
    it("includes a DONE verification with its four field marks and a click-through verificationId", async () => {
      const batchJobId = await trackBatch();
      const a = await createApplicationAndImageFixture(db, batchJobId, "bottle-01.jpg");
      const [verification] = await db
        .insert(verifications)
        .values({ applicationId: a.applicationId, labelImageId: a.labelImageId, batchJobId, verdict: "PASS", resolutionPath: "EXTRACTOR_ONLY" })
        .returning();
      await db.insert(fieldResults).values([
        { verificationId: verification.id, fieldName: "BRAND_NAME", evidence: "Highland Peak", confidence: 0.95, verdict: "MATCH", reason: "Matches the application." },
        { verificationId: verification.id, fieldName: "ALCOHOL_CONTENT", evidence: "45% ALC/VOL", confidence: 0.95, verdict: "MATCH", reason: "Matches the application." },
        { verificationId: verification.id, fieldName: "NET_CONTENTS", evidence: "750 mL", confidence: 0.95, verdict: "MATCH", reason: "Matches the application." },
        { verificationId: verification.id, fieldName: "GOVERNMENT_WARNING", evidence: "GOVERNMENT WARNING...", confidence: 0.9, verdict: "MISMATCH", reason: "Does not match the required text." },
      ]);

      const result = await getBatchProgress(db, batchJobId);
      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.progress.results).toHaveLength(1);
      const row = result.progress.results[0];
      expect(row.verificationId).toBe(verification.id);
      expect(row.label).toBe("bottle-01.jpg");
      expect(row.brand).toBe("MATCH");
      expect(row.abv).toBe("MATCH");
      expect(row.net).toBe("MATCH");
      expect(row.warning).toBe("MISMATCH");
      expect(row.statusTone).toBe("pass");
    });

    it("gives a REVIEW verification a plain-English status built from its review_queue reason", async () => {
      const batchJobId = await trackBatch();
      const a = await createApplicationAndImageFixture(db, batchJobId, "bottle-02.jpg");
      const [verification] = await db
        .insert(verifications)
        .values({ applicationId: a.applicationId, labelImageId: a.labelImageId, batchJobId, verdict: "REVIEW", resolutionPath: "EXTRACTOR_ONLY" })
        .returning();
      await db.insert(reviewQueue).values({ verificationId: verification.id, reason: "AMBIGUOUS_BRAND" });

      const result = await getBatchProgress(db, batchJobId);
      expect(result.found).toBe(true);
      if (!result.found) return;
      const row = result.progress.results[0];
      expect(row.statusTone).toBe("review");
      expect(row.statusText.length).toBeGreaterThan(0);
      expect(row.statusText).not.toMatch(/^\d+(\.\d+)?%?$/); // never a bare confidence number (standing rule 12)
    });

    it("shows a reviewer's disposition once recorded, distinct from the raw verdict", async () => {
      const batchJobId = await trackBatch();
      const a = await createApplicationAndImageFixture(db, batchJobId, "bottle-03.jpg");
      const [verification] = await db
        .insert(verifications)
        .values({ applicationId: a.applicationId, labelImageId: a.labelImageId, batchJobId, verdict: "REVIEW", resolutionPath: "EXTRACTOR_ONLY" })
        .returning();
      await db.insert(reviewQueue).values({ verificationId: verification.id, reason: "AMBIGUOUS_BRAND", disposition: "APPROVED", disposedAt: new Date() });

      const result = await getBatchProgress(db, batchJobId);
      expect(result.found).toBe(true);
      if (!result.found) return;
      const row = result.progress.results[0];
      expect(row.statusTone).toBe("pass");
      expect(row.statusText).toMatch(/approved/i);
    });

    it("includes a FAILED EXTRACT item (no verification row) with its stored last_error as status detail, and no click-through", async () => {
      const batchJobId = await trackBatch();
      const a = await createApplicationAndImageFixture(db, batchJobId, "corrupt.jpg");
      const itemId = await enqueueExtractItemFixture(db, { batchJobId, applicationId: a.applicationId, labelImageId: a.labelImageId }, { status: "FAILED" });
      await db.execute(sql`UPDATE batch_queue_items SET last_error = 'LabelHunter cannot open this file. It may be damaged. Take a new photo and try again.' WHERE id = ${itemId}`);

      const result = await getBatchProgress(db, batchJobId);
      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.progress.results).toHaveLength(1);
      const row = result.progress.results[0];
      expect(row.verificationId).toBeNull();
      expect(row.statusTone).toBe("failed");
      expect(row.statusDetail).toMatch(/damaged/i);
      expect(row.label).toBe("corrupt.jpg");
    });

    it("shows a still-queued EXTRACT item as 'Queued', and a claimed one as being processed — never blank", async () => {
      const batchJobId = await trackBatch();
      const a = await createApplicationAndImageFixture(db, batchJobId, "queued.jpg");
      const b = await createApplicationAndImageFixture(db, batchJobId, "processing.jpg");
      await enqueueExtractItemFixture(db, { batchJobId, applicationId: a.applicationId, labelImageId: a.labelImageId }, { status: "PENDING" });
      await enqueueExtractItemFixture(db, { batchJobId, applicationId: b.applicationId, labelImageId: b.labelImageId }, { status: "CLAIMED" });

      const result = await getBatchProgress(db, batchJobId);
      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.progress.results).toHaveLength(2);
      for (const row of result.progress.results) {
        expect(row.statusTone).toBe("pending");
        expect(row.statusText.length).toBeGreaterThan(0);
        expect(row.verificationId).toBeNull();
      }
      const byLabel = new Map(result.progress.results.map((r) => [r.label, r]));
      expect(byLabel.get("queued.jpg")?.statusText).toMatch(/queue/i);
      expect(byLabel.get("processing.jpg")?.statusText).toMatch(/process/i);
    });

    it("never duplicates or drops a label across the three sources — total rows equal total queue items", async () => {
      const batchJobId = await trackBatch();
      const a = await createApplicationAndImageFixture(db, batchJobId, "done.jpg");
      const b = await createApplicationAndImageFixture(db, batchJobId, "failed.jpg");
      const c = await createApplicationAndImageFixture(db, batchJobId, "pending.jpg");

      await db.insert(verifications).values({ applicationId: a.applicationId, labelImageId: a.labelImageId, batchJobId, verdict: "PASS", resolutionPath: "EXTRACTOR_ONLY" });
      // A DONE verification still has its own EXTRACT queue row (DONE too)
      // — insert it so the "no duplication" check is real, not vacuous.
      await enqueueExtractItemFixture(db, { batchJobId, applicationId: a.applicationId, labelImageId: a.labelImageId }, { status: "DONE" });
      await enqueueExtractItemFixture(db, { batchJobId, applicationId: b.applicationId, labelImageId: b.labelImageId }, { status: "FAILED" });
      await enqueueExtractItemFixture(db, { batchJobId, applicationId: c.applicationId, labelImageId: c.labelImageId }, { status: "PENDING" });

      const result = await getBatchProgress(db, batchJobId);
      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.progress.results).toHaveLength(3);
      const labels = result.progress.results.map((r) => r.label).sort();
      expect(labels).toEqual(["done.jpg", "failed.jpg", "pending.jpg"]);
    });
  });
});
