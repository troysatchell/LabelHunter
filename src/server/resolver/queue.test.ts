/**
 * `insertReviewQueueEntry` against a real Postgres database — this
 * worktree's own, via `.factory-env` (DATABASE_URL). No mocking here: the
 * whole point is to prove the unique-per-verification constraint and the
 * jsonb round-trip actually work against the schema TRO-457 shipped, not
 * against an assumption about how Drizzle would behave.
 *
 * Every test creates its own application/labelImage/verification fixtures
 * and deletes them in `finally` — deleting the application cascades to the
 * label image, verification, and review_queue row (every FK in
 * `../../lib/db/schema.ts` is `onDelete: "cascade"`), so one delete cleans
 * up the whole fixture tree and this suite leaves the database exactly as
 * it found it, safe to re-run.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { applications, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import { findExistingReviewQueueEntry, insertReviewQueueEntry } from "./queue";
import type { ResolverResolution } from "./types";

async function makeVerificationFixture() {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: "TRO-464 Test Fixture",
      classType: "Straight Bourbon Whiskey",
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();

  const [labelImage] = await db
    .insert(labelImages)
    .values({
      applicationId: application.id,
      storagePath: "test-fixtures/tro-464.jpg",
      originalFilename: "tro-464.jpg",
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

const SAMPLE_RESOLUTION: ResolverResolution = {
  outcome: "resolved",
  fields: [
    {
      kind: "judged",
      field: "brand_name",
      disposition: "RESOLVED_MATCH",
      correctedValue: "Stone's Throw",
      evidence: "STONE'S THROW",
      reason: "Matches the application.",
      confidence: 0.95,
    },
  ],
};

describe("insertReviewQueueEntry — real database", () => {
  it("inserts a row with disposition null, readable back exactly", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      const { id } = await insertReviewQueueEntry({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: SAMPLE_RESOLUTION,
      });
      expect(id).toBeGreaterThan(0);

      const [row] = await db.query.reviewQueue.findMany({ where: (rq, { eq: eqOp }) => eqOp(rq.id, id) });
      expect(row.verificationId).toBe(verificationId);
      expect(row.reason).toBe("AMBIGUOUS_BRAND");
      expect(row.disposition).toBeNull();
      expect(row.disposedAt).toBeNull();
      expect(row.resolverOutput).toEqual(SAMPLE_RESOLUTION);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("stores a needs-human resolution the same way — disposition still null", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      const needsHuman: ResolverResolution = {
        outcome: "needs-human",
        fields: [
          {
            kind: "correction",
            field: "alcohol_content",
            needsHuman: true,
            correctedValue: null,
            evidence: "",
            reason: "Glare obscures the numeral even at full resolution.",
            confidence: 0.3,
          },
        ],
      };
      const { id } = await insertReviewQueueEntry({
        verificationId,
        reason: "AMBIGUOUS_ABV",
        resolverOutput: needsHuman,
      });

      const [row] = await db.query.reviewQueue.findMany({ where: (rq, { eq: eqOp }) => eqOp(rq.id, id) });
      expect(row.disposition).toBeNull();
      expect((row.resolverOutput as ResolverResolution).outcome).toBe("needs-human");
    } finally {
      await cleanup(applicationId);
    }
  });

  it("enforces at most one review_queue row per verification — a second insert throws", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      await insertReviewQueueEntry({ verificationId, reason: "AMBIGUOUS_BRAND", resolverOutput: SAMPLE_RESOLUTION });
      await expect(
        insertReviewQueueEntry({ verificationId, reason: "AMBIGUOUS_ABV", resolverOutput: SAMPLE_RESOLUTION }),
      ).rejects.toThrow();
    } finally {
      await cleanup(applicationId);
    }
  });
});

describe("findExistingReviewQueueEntry — real database", () => {
  it("returns null when no row exists yet for this verification", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      expect(await findExistingReviewQueueEntry(verificationId)).toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });

  it("finds the row insertReviewQueueEntry just wrote — the round trip a duplicate call relies on", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      const { id } = await insertReviewQueueEntry({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: SAMPLE_RESOLUTION,
      });

      const found = await findExistingReviewQueueEntry(verificationId);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(id);
      expect(found?.resolverOutput).toEqual(SAMPLE_RESOLUTION);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("throws on a row whose resolverOutput does not match ResolverResolution's shape — e.g. db:seed's own legacy fixture", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      // Written directly, bypassing insertReviewQueueEntry's typed
      // ResolverResolution param — this is exactly what db:seed.ts's own
      // ad hoc `{ resolvedAbvPercent, note, confidence }` shape looks like
      // from findExistingReviewQueueEntry's point of view: real data in the
      // table, but not this module's shape.
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_ABV",
        resolverOutput: { resolvedAbvPercent: 13.5, note: "legacy fixture shape", confidence: 0.93 },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });
});
