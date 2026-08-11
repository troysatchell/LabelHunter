/**
 * `getReviewQueueItem` against a real Postgres database — same rationale
 * and fixture/cleanup discipline as `list.test.ts` and
 * `src/server/resolver/queue.test.ts`. Every fixture here is looked up by
 * its own id, never by scanning the whole table, so this suite is safe to
 * run alongside every other `*.test.ts` file sharing this worktree's
 * database.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { applications, fieldResults, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import type { ReviewReason } from "../../lib/db/enums";
import type { ResolverResolution } from "../resolver/types";
import { getReviewQueueItem } from "./get-item";

interface FixtureOptions {
  reason?: ReviewReason;
  resolverOutput?: unknown;
  alcoholContentRaw?: string | null;
}

async function makeQueueItemFixture(options: FixtureOptions = {}) {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      // `??` would treat an explicit `null` override the same as "not
      // provided" — this fixture needs to tell the two apart, so it checks
      // `undefined` specifically.
      alcoholContentRaw: options.alcoholContentRaw === undefined ? "45%" : options.alcoholContentRaw,
      abvPercent: 45,
      netContentsRaw: "750 mL",
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

  await db.insert(fieldResults).values([
    {
      verificationId: verification.id,
      fieldName: "BRAND_NAME",
      extractedValue: "Old Tom Distillery",
      evidence: "OLD TOM DISTILLERY",
      confidence: 0.7,
      verdict: "NEEDS_REVIEW",
      reason: "A reviewer must check the brand name or class and type against the label.",
    },
    {
      verificationId: verification.id,
      fieldName: "ALCOHOL_CONTENT",
      extractedValue: "45%",
      evidence: "45% ALC/VOL",
      confidence: 0.98,
      verdict: "MATCH",
      reason: "Matches the application.",
    },
  ]);

  const [queueRow] = await db
    .insert(reviewQueue)
    .values({
      verificationId: verification.id,
      reason: options.reason ?? "AMBIGUOUS_BRAND",
      resolverOutput: options.resolverOutput ?? null,
    })
    .returning();

  return { applicationId: application.id, verificationId: verification.id, queueId: queueRow.id };
}

async function cleanup(applicationId: number) {
  await db.delete(applications).where(eq(applications.id, applicationId));
}

const SAMPLE_RESOLUTION: ResolverResolution = {
  outcome: "resolved",
  fields: [
    {
      kind: "judged",
      field: "brand_name",
      disposition: "RESOLVED_MATCH",
      correctedValue: "Old Tom Distillery",
      evidence: "OLD TOM DISTILLERY",
      reason: "Matches the application.",
      confidence: 0.95,
    },
  ],
};

describe("getReviewQueueItem — real database", () => {
  it("returns found:false for a nonexistent id", async () => {
    const result = await getReviewQueueItem(db, 999_999_999);
    expect(result.found).toBe(false);
  });

  it("returns the full per-field comparison and a null resolver section — the normal case today", async () => {
    const { applicationId, verificationId, queueId } = await makeQueueItemFixture();
    try {
      const result = await getReviewQueueItem(db, queueId);
      expect(result.found).toBe(true);
      if (!result.found) throw new Error("expected found: true");

      expect(result.item.verificationId).toBe(verificationId);
      expect(result.item.applicationId).toBe(applicationId);
      expect(result.item.reason).toBe("AMBIGUOUS_BRAND");
      expect(result.item.disposition).toBeNull();
      expect(result.item.disposedAt).toBeNull();
      // Nothing has called the resolver off this row — resolverOutput is
      // null, and that is the normal, expected shape, not an error state.
      expect(result.item.resolverNote).toBeNull();
      expect(result.item.resolverFields).toBeNull();

      const brandRow = result.item.fields.find((f) => f.field === "BRAND_NAME");
      expect(brandRow?.fieldLabel).toBe("Brand name");
      expect(brandRow?.verdict).toBe("NEEDS_REVIEW");
      expect(brandRow?.evidence).toBe("OLD TOM DISTILLERY");
      expect(brandRow?.applicationValue).toBe("Old Tom Distillery");

      const abvRow = result.item.fields.find((f) => f.field === "ALCOHOL_CONTENT");
      expect(abvRow?.applicationValue).toBe("45%");
      // Never a bare confidence percentage anywhere (TH-R20).
      for (const row of result.item.fields) {
        expect(row.reason).not.toMatch(/\d+(\.\d+)?%/);
      }
    } finally {
      await cleanup(applicationId);
    }
  });

  it("falls back to the not-filed phrase when an optional field was left blank on the application", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture({ alcoholContentRaw: null });
    try {
      const result = await getReviewQueueItem(db, queueId);
      if (!result.found) throw new Error("expected found: true");
      const abvRow = result.item.fields.find((f) => f.field === "ALCOHOL_CONTENT");
      expect(abvRow?.applicationValue).toBe("(not filed on the application)");
    } finally {
      await cleanup(applicationId);
    }
  });

  it("reads a structured resolver suggestion when resolverOutput matches the resolver's own shape", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture({ resolverOutput: SAMPLE_RESOLUTION });
    try {
      const result = await getReviewQueueItem(db, queueId);
      if (!result.found) throw new Error("expected found: true");
      expect(result.item.resolverFields).toHaveLength(1);
      expect(result.item.resolverFields?.[0]).toMatchObject({
        field: "brand_name",
        kind: "judged",
        disposition: "RESOLVED_MATCH",
        correctedValue: "Old Tom Distillery",
      });
      // Standing rule 12 — never a bare confidence number, even one
      // traveling inside a resolver's own output.
      expect(result.item.resolverFields?.[0]).not.toHaveProperty("confidence");
    } finally {
      await cleanup(applicationId);
    }
  });

  it("reads the free-text note from a legacy resolverOutput shape without crashing", async () => {
    // db:seed.ts's own ad hoc fixture shape — no `outcome`/`fields` at all,
    // just `{ resolvedAbvPercent, note, confidence }`. This module degrades
    // gracefully for DISPLAY (unlike src/server/resolver/queue.ts's
    // findExistingReviewQueueEntry, which throws on this exact shape
    // because it is gating a real-money decision, not rendering a page for
    // a human who is already looking at the underlying data).
    const legacyShape = {
      resolvedAbvPercent: 13.5,
      note: "Re-read the ABV line at higher zoom; glare was cosmetic.",
      confidence: 0.93,
    };
    const { applicationId, queueId } = await makeQueueItemFixture({ resolverOutput: legacyShape });
    try {
      const result = await getReviewQueueItem(db, queueId);
      if (!result.found) throw new Error("expected found: true");
      expect(result.item.resolverNote).toBe("Re-read the ABV line at higher zoom; glare was cosmetic.");
      expect(result.item.resolverFields).toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });

  it("does not crash on a resolverOutput that matches neither shape", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture({ resolverOutput: { unexpected: true } });
    try {
      const result = await getReviewQueueItem(db, queueId);
      if (!result.found) throw new Error("expected found: true");
      expect(result.item.resolverNote).toBeNull();
      expect(result.item.resolverFields).toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });

  it("reflects an already-disposed item's disposition in the detail, rather than hiding it", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      await db
        .update(reviewQueue)
        .set({ disposition: "REJECTED", disposedAt: new Date() })
        .where(eq(reviewQueue.id, queueId));

      const result = await getReviewQueueItem(db, queueId);
      if (!result.found) throw new Error("expected found: true");
      expect(result.item.disposition).toBe("REJECTED");
      expect(result.item.disposedAt).not.toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });
});
