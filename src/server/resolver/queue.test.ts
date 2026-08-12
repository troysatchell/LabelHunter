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
import { findExistingReviewQueueEntry, insertReviewQueueEntry, insertSkippedReviewQueueEntry } from "./queue";
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

  it("throws on a valid outcome with a malformed fields member — PR #10 review", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      // A shallower check that only looked at `outcome` and `Array.isArray(fields)`
      // previously accepted this row and returned `fields: [null]` as a real
      // ResolverResolution — a data-integrity gap this row exercises directly.
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: { outcome: "resolved", fields: [null] },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("throws when a fields member has an unrecognized kind", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: {
          outcome: "resolved",
          fields: [{ kind: "bogus", field: "brand_name", evidence: "x", reason: "x", confidence: 0.9, correctedValue: "x" }],
        },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("throws when a judged field carries a field name from the wrong branch (a correction field's name)", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: {
          outcome: "resolved",
          fields: [
            {
              kind: "judged",
              field: "government_warning", // illegal — government_warning is a correction field
              disposition: "RESOLVED_MATCH",
              correctedValue: "x",
              evidence: "x",
              reason: "x",
              confidence: 0.9,
            },
          ],
        },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("throws when a fields member's confidence is out of the [0, 1] range — PR #10 review round 2", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      // response.ts's own validation would reject confidence: 42 outright
      // (ValidationContext.unitInterval). A row written directly to the
      // table, bypassing that parse step, must be rejected the same way —
      // otherwise a corrupted row is returned to a caller as if Sonnet had
      // actually reported 42 out of a possible 1.
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: {
          outcome: "resolved",
          fields: [
            {
              kind: "judged",
              field: "brand_name",
              disposition: "RESOLVED_MATCH",
              correctedValue: "Stone's Throw",
              evidence: "STONE'S THROW",
              reason: "Matches the application.",
              confidence: 42,
            },
          ],
        },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("throws when the stored outcome is \"resolved\" but a judged field's disposition is NEEDS_HUMAN — PR #10 review round 2", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      // deriveOutcome (response.ts) would recompute "needs-human" from this
      // exact fields array. A stored row claiming "resolved" anyway is
      // self-contradictory — the same shape of gap the judges-only-
      // brand/class rule already guards against on the parsing side.
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: {
          outcome: "resolved",
          fields: [
            {
              kind: "judged",
              field: "brand_name",
              disposition: "NEEDS_HUMAN",
              correctedValue: null,
              evidence: "STONE'S THROW",
              reason: "Illegible even at full resolution.",
              confidence: 0.4,
            },
          ],
        },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("throws when the stored outcome is \"resolved\" but a correction field's needsHuman is true — PR #10 review round 2", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_ABV",
        resolverOutput: {
          outcome: "resolved",
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
        },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("throws when the stored outcome is \"needs-human\" but every field is actually decided — PR #10 review round 2", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      // The mismatch check must catch both directions — an "optimistic"
      // outcome and a "pessimistic" one are equally a sign the stored
      // outcome was not really recomputed from these fields.
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: {
          outcome: "needs-human",
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
        },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("throws on a stored resolution whose fields array is empty — PR #10 review round 3", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      // deriveOutcome([]) returns "resolved" — an empty array's .every(...)
      // is vacuously true, the same shape of gap response.ts's own
      // deriveResolvedFields already guards against for an empty
      // flaggedFields list. A stored row with no fields at all is not a
      // real resolution of anything and must not be handed back to a
      // caller as one.
      await db.insert(reviewQueue).values({
        verificationId,
        reason: "AMBIGUOUS_BRAND",
        resolverOutput: { outcome: "resolved", fields: [] },
      });

      await expect(findExistingReviewQueueEntry(verificationId)).rejects.toThrow(/does not match/);
    } finally {
      await cleanup(applicationId);
    }
  });
});

describe("insertSkippedReviewQueueEntry — real database (LH-041 / TRO-474, CP-3 §6.2/§6.4)", () => {
  it("inserts a row with resolverOutput null and resolverSkipReason set — never both null, never both set", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      const { id } = await insertSkippedReviewQueueEntry({
        verificationId,
        reason: "AMBIGUOUS_ABV",
        resolverSkipReason: "ESCALATION_CAP_EXCEEDED",
      });
      expect(id).toBeGreaterThan(0);

      const [row] = await db.query.reviewQueue.findMany({ where: (rq, { eq: eqOp }) => eqOp(rq.id, id) });
      expect(row.verificationId).toBe(verificationId);
      expect(row.reason).toBe("AMBIGUOUS_ABV");
      expect(row.resolverOutput).toBeNull();
      expect(row.resolverSkipReason).toBe("ESCALATION_CAP_EXCEEDED");
      expect(row.disposition).toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });

  it("still enforces at most one review_queue row per verification", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      await insertSkippedReviewQueueEntry({ verificationId, reason: "AMBIGUOUS_ABV", resolverSkipReason: "ESCALATION_CAP_EXCEEDED" });
      await expect(
        insertSkippedReviewQueueEntry({ verificationId, reason: "AMBIGUOUS_ABV", resolverSkipReason: "ESCALATION_CAP_EXCEEDED" }),
      ).rejects.toThrow();
    } finally {
      await cleanup(applicationId);
    }
  });

  it("a skip-marker row and a real resolution are mutually exclusive at the database level (schema.ts's own CHECK constraint)", async () => {
    const { applicationId, verificationId } = await makeVerificationFixture();
    try {
      // insertReviewQueueEntry's own typed param does not allow passing
      // both resolverOutput and resolverSkipReason together — this proves
      // the DATABASE would also refuse it if some future caller bypassed
      // that type safety with a raw insert.
      await expect(
        db.insert(reviewQueue).values({
          verificationId,
          reason: "AMBIGUOUS_ABV",
          resolverOutput: SAMPLE_RESOLUTION,
          resolverSkipReason: "ESCALATION_CAP_EXCEEDED",
        }),
      ).rejects.toThrow();
    } finally {
      await cleanup(applicationId);
    }
  });
});
