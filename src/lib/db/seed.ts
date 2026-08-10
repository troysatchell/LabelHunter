/**
 * Dev fixture data for the LabelHunter schema (LH-002 / TRO-457).
 *
 * Run with `pnpm db:seed`. Inserts a small, obviously fake dataset across
 * all six product tables so a developer can sanity-check the relationships
 * (application ↔ image ↔ verification ↔ field results ↔ review queue,
 * plus a batch job tying a subset of those together) without hand-writing
 * SQL. Every brand, filename, and warning variant below is invented for
 * this seed — none of it is real label data, and none of it is PII
 * (TH-R6): no names, emails, or addresses of real people anywhere.
 *
 * Not idempotent by design — a dev database is expected to be empty or
 * freshly migrated before running this. It refuses to run (loudly, not
 * silently) against a database that already has application rows, so a
 * second accidental run doesn't produce duplicate fixtures.
 *
 * Every insert below runs inside one transaction. If any statement fails,
 * Postgres rolls back the whole batch — a failure partway through never
 * leaves a half-seeded database that would (wrongly) pass the "already
 * seeded" guard above on the next run without ever finishing.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const CANONICAL_WARNING =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should " +
  "not drink alcoholic beverages during pregnancy because of the risk of " +
  "birth defects. (2) Consumption of alcoholic beverages impairs your " +
  "ability to drive a car or operate machinery, and may cause health " +
  "problems.";

// Same text, title-cased — the exact deviation PRD §3.4 names as Jenny's
// real catch: a caps-format failure the deterministic comparator must
// flag, distinct from a wording change.
const TITLE_CASE_WARNING =
  "Government Warning: (1) According To The Surgeon General, Women Should " +
  "Not Drink Alcoholic Beverages During Pregnancy Because Of The Risk Of " +
  "Birth Defects. (2) Consumption Of Alcoholic Beverages Impairs Your " +
  "Ability To Drive A Car Or Operate Machinery, And May Cause Health " +
  "Problems.";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Source .factory-env (factory worktree) or " +
        "set it from .env.local.example before running db:seed.",
    );
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  try {
    await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .limit(1);
    if (existing) {
      throw new Error(
        "db:seed: applications table already has rows. This script is not " +
          "idempotent — run it only against an empty/freshly migrated " +
          "database, or clear the product tables first.",
      );
    }

    // A completed batch of two, one auto-verified and one escalated —
    // exercises batch_jobs' progress counters (PRD §3.5).
    const [batch] = await tx
      .insert(schema.batchJobs)
      .values({
        status: "COMPLETED",
        totalCount: 2,
        processedCount: 2,
        autoVerifiedCount: 1,
        resolvedBySonnetCount: 0,
        needsHumanCount: 1,
        failedCount: 0,
        startedAt: new Date("2026-08-01T09:00:00Z"),
        completedAt: new Date("2026-08-01T09:04:00Z"),
      })
      .returning();

    // Single-label verify: a clean match (no batch).
    const [appStonesThrow] = await db
      .insert(schema.applications)
      .values({
        beverageType: "spirits",
        brandName: "Stone's Throw",
        classType: "Straight Bourbon Whiskey",
        alcoholContentRaw: "45% ALC/VOL (90 PROOF)",
        abvPercent: 45.0,
        proof: 90.0,
        netContentsRaw: "750 mL",
        netContentsValue: 750,
        netContentsUnit: "mL",
      })
      .returning();

    // Batch row 1: wine, ABV reads low-confidence on the label -> review.
    const [appMillerVineyards] = await db
      .insert(schema.applications)
      .values({
        batchJobId: batch.id,
        beverageType: "wine",
        brandName: "Miller Family Vineyards",
        classType: "Cabernet Sauvignon",
        alcoholContentRaw: "13.5% ALC/VOL",
        abvPercent: 13.5,
        netContentsRaw: "750 mL",
        netContentsValue: 750,
        netContentsUnit: "mL",
      })
      .returning();

    // Single-label verify: a deterministic FAIL (title-case warning) that
    // never needs Sonnet — shows a verification with no review_queue row.
    const [appHazyTrail] = await db
      .insert(schema.applications)
      .values({
        beverageType: "beer",
        brandName: "Hazy Trail Brewing",
        classType: "India Pale Ale",
        alcoholContentRaw: "6.2% ALC/VOL",
        abvPercent: 6.2,
        netContentsRaw: "16 FL OZ",
        netContentsValue: 16,
        netContentsUnit: "fl oz",
      })
      .returning();

    // Single-label image: linked straight to its application at upload.
    const [imgStonesThrow] = await db
      .insert(schema.labelImages)
      .values({
        applicationId: appStonesThrow.id,
        storagePath: "dev-seed/stones-throw-front.jpg",
        originalFilename: "stones_throw_front.jpg",
        widthPx: 1600,
        heightPx: 2000,
      })
      .returning();

    // Batch image: linked to the batch job, not directly to an
    // application — the pairing lives in the verification row, matching
    // PRD §3.5's filename-pairing flow.
    const [imgMillerVineyards] = await db
      .insert(schema.labelImages)
      .values({
        batchJobId: batch.id,
        storagePath: "dev-seed/miller-vineyards-front.jpg",
        originalFilename: "miller_vineyards_front.jpg",
        widthPx: 1500,
        heightPx: 1900,
      })
      .returning();

    const [imgHazyTrail] = await db
      .insert(schema.labelImages)
      .values({
        applicationId: appHazyTrail.id,
        storagePath: "dev-seed/hazy-trail-ipa.jpg",
        originalFilename: "hazy_trail_ipa.jpg",
        widthPx: 1400,
        heightPx: 1800,
      })
      .returning();

    const [verStonesThrow] = await db
      .insert(schema.verifications)
      .values({
        applicationId: appStonesThrow.id,
        labelImageId: imgStonesThrow.id,
        verdict: "PASS",
        resolutionPath: "EXTRACTOR_ONLY",
      })
      .returning();

    const [verMillerVineyards] = await db
      .insert(schema.verifications)
      .values({
        applicationId: appMillerVineyards.id,
        labelImageId: imgMillerVineyards.id,
        batchJobId: batch.id,
        verdict: "REVIEW",
        resolutionPath: "EXTRACTOR_RESOLVER",
      })
      .returning();

    const [verHazyTrail] = await db
      .insert(schema.verifications)
      .values({
        applicationId: appHazyTrail.id,
        labelImageId: imgHazyTrail.id,
        verdict: "FAIL",
        resolutionPath: "EXTRACTOR_ONLY",
      })
      .returning();

    await db.insert(schema.fieldResults).values([
      // Stone's Throw — clean match on every field.
      {
        verificationId: verStonesThrow.id,
        fieldName: "BRAND_NAME",
        extractedValue: "Stone's Throw",
        evidence: "STONE'S THROW",
        confidence: 0.98,
        verdict: "MATCH",
        reason: "Normalized brand name matches the application exactly.",
      },
      {
        verificationId: verStonesThrow.id,
        fieldName: "CLASS_TYPE",
        extractedValue: "Straight Bourbon Whiskey",
        evidence: "STRAIGHT BOURBON WHISKEY",
        confidence: 0.97,
        verdict: "MATCH",
        reason: "Class/type matches the application exactly.",
      },
      {
        verificationId: verStonesThrow.id,
        fieldName: "ALCOHOL_CONTENT",
        extractedValue: "45% ALC/VOL (90 PROOF)",
        evidence: "45% Alc./Vol. (90 Proof)",
        confidence: 0.96,
        verdict: "MATCH",
        reason: "ABV and proof both match; proof is 2x ABV as expected.",
      },
      {
        verificationId: verStonesThrow.id,
        fieldName: "NET_CONTENTS",
        extractedValue: "750 mL",
        evidence: "750 mL",
        confidence: 0.99,
        verdict: "MATCH",
        reason: "Net contents value and unit match the application.",
      },
      {
        verificationId: verStonesThrow.id,
        fieldName: "GOVERNMENT_WARNING",
        extractedValue: CANONICAL_WARNING,
        evidence: CANONICAL_WARNING,
        confidence: 0.95,
        verdict: "MATCH",
        reason: "Warning text matches the canonical 27 CFR part 16 wording exactly.",
      },
      // Miller Family Vineyards — ABV reads low-confidence -> review.
      {
        verificationId: verMillerVineyards.id,
        fieldName: "BRAND_NAME",
        extractedValue: "Miller Family Vineyards",
        evidence: "MILLER FAMILY VINEYARDS",
        confidence: 0.95,
        verdict: "MATCH",
        reason: "Normalized brand name matches the application exactly.",
      },
      {
        verificationId: verMillerVineyards.id,
        fieldName: "CLASS_TYPE",
        extractedValue: "Cabernet Sauvignon",
        evidence: "CABERNET SAUVIGNON",
        confidence: 0.94,
        verdict: "MATCH",
        reason: "Class/type matches the application exactly.",
      },
      {
        verificationId: verMillerVineyards.id,
        fieldName: "ALCOHOL_CONTENT",
        extractedValue: "13.5% ALC/VOL",
        evidence: "13.5% Alc./Vol.",
        confidence: 0.62,
        verdict: "NEEDS_REVIEW",
        reason: "Glare over the ABV numeral drops extraction confidence below threshold.",
      },
      {
        verificationId: verMillerVineyards.id,
        fieldName: "NET_CONTENTS",
        extractedValue: "750 mL",
        evidence: "750 mL",
        confidence: 0.98,
        verdict: "MATCH",
        reason: "Net contents value and unit match the application.",
      },
      {
        verificationId: verMillerVineyards.id,
        fieldName: "GOVERNMENT_WARNING",
        extractedValue: CANONICAL_WARNING,
        evidence: CANONICAL_WARNING,
        confidence: 0.93,
        verdict: "MATCH",
        reason: "Warning text matches the canonical 27 CFR part 16 wording exactly.",
      },
      // Hazy Trail — deterministic FAIL on the warning, no escalation needed.
      {
        verificationId: verHazyTrail.id,
        fieldName: "BRAND_NAME",
        extractedValue: "Hazy Trail Brewing",
        evidence: "HAZY TRAIL BREWING",
        confidence: 0.97,
        verdict: "MATCH",
        reason: "Normalized brand name matches the application exactly.",
      },
      {
        verificationId: verHazyTrail.id,
        fieldName: "CLASS_TYPE",
        extractedValue: "India Pale Ale",
        evidence: "INDIA PALE ALE",
        confidence: 0.96,
        verdict: "MATCH",
        reason: "Class/type matches the application exactly.",
      },
      {
        verificationId: verHazyTrail.id,
        fieldName: "ALCOHOL_CONTENT",
        extractedValue: "6.2% ALC/VOL",
        evidence: "6.2% Alc./Vol.",
        confidence: 0.95,
        verdict: "MATCH",
        reason: "ABV matches the application.",
      },
      {
        verificationId: verHazyTrail.id,
        fieldName: "NET_CONTENTS",
        extractedValue: "16 FL OZ",
        evidence: "16 FL OZ",
        confidence: 0.97,
        verdict: "MATCH",
        reason: "Net contents value and unit match the application.",
      },
      {
        verificationId: verHazyTrail.id,
        fieldName: "GOVERNMENT_WARNING",
        extractedValue: TITLE_CASE_WARNING,
        evidence: TITLE_CASE_WARNING,
        confidence: 0.91,
        verdict: "MISMATCH",
        reason: "Warning text is title case, not the statutory all-caps heading format.",
      },
    ]);

    // Only the Miller Vineyards verification needs a human — the review
    // queue row's disposition stays null (not yet resolved by a person),
    // even though the Sonnet resolver has already produced output.
    await db.insert(schema.reviewQueue).values({
      verificationId: verMillerVineyards.id,
      reason: "AMBIGUOUS_ABV",
      resolverOutput: {
        resolvedAbvPercent: 13.5,
        note: "Re-read the ABV line at higher zoom; glare was cosmetic. Value reads 13.5%, matching the application.",
        confidence: 0.93,
      },
    });

    console.log("db:seed: inserted 1 batch job, 3 applications, 3 label images,");
    console.log("         3 verifications, 15 field results, 1 review-queue item.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
