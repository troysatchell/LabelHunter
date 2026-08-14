import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import type { ReviewReason } from "../../lib/db/enums";
import { applications, fieldResults, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import { getVerificationDetail } from "./get-verification-detail";

// Real worktree Postgres, matching src/app/api/verify/route.test.ts's own
// convention — this module's whole job is shaping already-persisted rows,
// so a fake DB client would just be re-asserting this file's own mock.
// Run this file only with DATABASE_URL pointed at the worktree's own
// database (source .factory-env first): it inserts and deletes real
// rows, and provisioning resets that database's schema.
//
// The fixture brand is "TRO-466 Test Fixture" (this module's own origin
// ticket), not "Old Tom Distillery" (TRO-513) — this suite inserts
// field_results directly with hardcoded verdicts, so it never runs a real
// comparator against the brand text; it only needs a value that echoes
// back through the read path. The canonical example stays load-bearing in
// src/app/api/verify/route.test.ts, the one place a real comparator runs
// against it.

const createdApplicationIds: number[] = [];

afterEach(async () => {
  // Cascades to label_images, verifications, field_results, review_queue
  // (every FK in schema.ts is ON DELETE CASCADE).
  for (const id of createdApplicationIds.splice(0)) {
    await db.delete(applications).where(eq(applications.id, id));
  }
});

interface SeedOverrides {
  verdict?: "PASS" | "FAIL" | "REVIEW";
  resolutionPath?: "EXTRACTOR_ONLY" | "EXTRACTOR_RESOLVER";
  alcoholContentRaw?: string | null;
  reviewQueue?: { reason: ReviewReason; resolverOutput?: unknown };
  warningVerdict?: "MATCH" | "MISMATCH" | "NEEDS_REVIEW";
  /** TRO-533 — an untyped `jsonb` value, matching the column's own real
   * shape: this test writes whatever a caller passes, so a malformed-shape
   * test can prove `getVerificationDetail`'s boundary check degrades to
   * `null` rather than trusting the column just because it is set. */
  boldSignal?: unknown;
}

interface Fixture {
  applicationId: number;
  verificationId: number;
  labelImageId: number;
}

/** Inserts one full verification (application, label image, verification,
 * all five field_results rows, and an optional review_queue row) directly
 * through Drizzle — the same "seed the real tables, read them back" shape
 * `route.test.ts` uses for its own persistence assertions. */
async function seedVerification(overrides: SeedOverrides = {}): Promise<Fixture> {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: "TRO-466 Test Fixture",
      classType: "Straight Bourbon Whiskey",
      alcoholContentRaw: overrides.alcoholContentRaw === undefined ? "45%" : overrides.alcoholContentRaw,
      abvPercent: 45,
      netContentsRaw: "750 mL",
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();
  createdApplicationIds.push(application.id);

  const [labelImage] = await db
    .insert(labelImages)
    .values({
      applicationId: application.id,
      storagePath: "uploads/test-fixture-front.jpg",
      originalFilename: "front.jpg",
      widthPx: 1200,
      heightPx: 1600,
    })
    .returning();

  const [verification] = await db
    .insert(verifications)
    .values({
      applicationId: application.id,
      labelImageId: labelImage.id,
      verdict: overrides.verdict ?? "PASS",
      resolutionPath: overrides.resolutionPath ?? "EXTRACTOR_ONLY",
      boldSignal: overrides.boldSignal ?? null,
    })
    .returning();

  await db.insert(fieldResults).values([
    {
      verificationId: verification.id,
      fieldName: "BRAND_NAME",
      extractedValue: "TRO-466 Test Fixture",
      evidence: "TRO-466 TEST FIXTURE",
      confidence: 0.95,
      verdict: "MATCH",
      reason: "Matches the application.",
    },
    {
      verificationId: verification.id,
      fieldName: "CLASS_TYPE",
      extractedValue: "Straight Bourbon Whiskey",
      evidence: "STRAIGHT BOURBON WHISKEY",
      confidence: 0.95,
      verdict: "MATCH",
      reason: "Matches the application.",
    },
    {
      verificationId: verification.id,
      fieldName: "ALCOHOL_CONTENT",
      extractedValue: "45%",
      evidence: "45% Alc./Vol.",
      confidence: 0.95,
      verdict: "MATCH",
      reason: "Matches the application.",
    },
    {
      verificationId: verification.id,
      fieldName: "NET_CONTENTS",
      extractedValue: "750 mL",
      evidence: "750 mL",
      confidence: 0.95,
      verdict: "MATCH",
      reason: "Matches the application.",
    },
    {
      verificationId: verification.id,
      fieldName: "GOVERNMENT_WARNING",
      extractedValue: "GOVERNMENT WARNING: (1) text",
      evidence: "GOVERNMENT WARNING: (1) text",
      confidence: 0.9,
      verdict: overrides.warningVerdict ?? "NEEDS_REVIEW",
      reason: "A reviewer must check the government warning against the label.",
    },
  ]);

  if (overrides.reviewQueue) {
    await db.insert(reviewQueue).values({
      verificationId: verification.id,
      reason: overrides.reviewQueue.reason,
      resolverOutput: overrides.reviewQueue.resolverOutput,
    });
  }

  return { applicationId: application.id, verificationId: verification.id, labelImageId: labelImage.id };
}

describe("getVerificationDetail — not found", () => {
  it("returns found: false for a verification id that does not exist", async () => {
    const result = await getVerificationDetail(db, 999_999_999);
    expect(result.found).toBe(false);
  });
});

describe("getVerificationDetail — a clean PASS", () => {
  it("shapes all five fields with labelValue, applicationValue, evidence, verdict, and reason", async () => {
    const fixture = await seedVerification();
    const result = await getVerificationDetail(db, fixture.verificationId);
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.verificationId).toBe(fixture.verificationId);
    expect(result.detail.applicationId).toBe(fixture.applicationId);
    expect(result.detail.labelVerdict).toBe("PASS");
    expect(result.detail.fields).toHaveLength(5);

    const brand = result.detail.fields.find((f) => f.field === "brand_name");
    expect(brand?.fieldLabel).toBe("Brand name");
    expect(brand?.labelValue).toBe("TRO-466 Test Fixture");
    expect(brand?.applicationValue).toBe("TRO-466 Test Fixture");
    expect(brand?.evidence).toBe("TRO-466 TEST FIXTURE");
    expect(brand?.verdict).toBe("MATCH");

    // alcohol_content's application value comes from the persisted raw
    // text the applicant filed (applications.alcohol_content_raw), not a
    // re-derivation from the numeric abv_percent column.
    const abv = result.detail.fields.find((f) => f.field === "alcohol_content");
    expect(abv?.applicationValue).toBe("45%");

    const net = result.detail.fields.find((f) => f.field === "net_contents");
    expect(net?.applicationValue).toBe("750 mL");
  });

  it("gives the government warning row a plain description, never a fabricated canonical-text comparison", async () => {
    const fixture = await seedVerification();
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    const warning = result.detail.fields.find((f) => f.field === "government_warning");
    expect(warning?.applicationValue).toBe("the statutory warning required by 27 CFR part 16");
    expect(warning?.labelValue).toBe("GOVERNMENT WARNING: (1) text");
  });

  it("builds the label image URL from the persisted label_images id, with real pixel dimensions", async () => {
    const fixture = await seedVerification();
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.labelImage.url).toBe(`/api/label-images/${fixture.labelImageId}`);
    expect(result.detail.labelImage.width).toBe(1200);
    expect(result.detail.labelImage.height).toBe(1600);
    expect(result.detail.labelImage.originalFilename).toBe("front.jpg");
  });

  it("reports resolvedBySonnet false and a null resolverNote when no resolver ran", async () => {
    const fixture = await seedVerification({ resolutionPath: "EXTRACTOR_ONLY" });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.resolvedBySonnet).toBe(false);
    expect(result.detail.resolverNote).toBeNull();
  });

  it("leaves headlineMessage null for a clean PASS", async () => {
    const fixture = await seedVerification({ verdict: "PASS" });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.headlineMessage).toBeNull();
  });
});

describe("getVerificationDetail — headlineMessage for a REVIEW verdict", () => {
  it("builds the same 'Needs review — {reason}' sentence route.ts builds live, from the persisted review_queue reason", async () => {
    const fixture = await seedVerification({
      verdict: "REVIEW",
      reviewQueue: { reason: "AMBIGUOUS_ABV" },
    });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.headlineMessage).toBe(
      "Needs review — A reviewer must check the alcohol content against the label.",
    );
  });

  it("leaves headlineMessage null for a REVIEW verdict with no review_queue row (a data anomaly, not a normal state)", async () => {
    const fixture = await seedVerification({ verdict: "REVIEW" });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.headlineMessage).toBeNull();
  });
});

describe("getVerificationDetail — an application value the applicant left blank", () => {
  it("falls back to the same '(not filed on the application)' phrase the router itself uses", async () => {
    const fixture = await seedVerification({ alcoholContentRaw: null });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    const abv = result.detail.fields.find((f) => f.field === "alcohol_content");
    expect(abv?.applicationValue).toBe("(not filed on the application)");
  });
});

describe("getVerificationDetail — resolved by Sonnet (PRD §5's annotation)", () => {
  it("reports resolvedBySonnet true when resolutionPath is EXTRACTOR_RESOLVER", async () => {
    const fixture = await seedVerification({
      verdict: "REVIEW",
      resolutionPath: "EXTRACTOR_RESOLVER",
      reviewQueue: {
        reason: "AMBIGUOUS_ABV",
        resolverOutput: { note: "Re-read the ABV line at higher zoom; matches the application.", confidence: 0.93 },
      },
    });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.resolvedBySonnet).toBe(true);
    expect(result.detail.resolverNote).toBe("Re-read the ABV line at higher zoom; matches the application.");
  });

  it("never surfaces resolverOutput's confidence number — only its free-text note (standing rule 12)", async () => {
    const fixture = await seedVerification({
      resolutionPath: "EXTRACTOR_RESOLVER",
      reviewQueue: { reason: "AMBIGUOUS_ABV", resolverOutput: { note: "See label at higher zoom.", confidence: 0.93 } },
    });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.resolverNote).not.toMatch(/0\.93|93%/);
  });

  it("returns a null resolverNote when resolver_output has no string note property — never crashes on an unrecognized shape", async () => {
    const fixture = await seedVerification({
      resolutionPath: "EXTRACTOR_RESOLVER",
      reviewQueue: { reason: "AMBIGUOUS_ABV", resolverOutput: { confidence: 0.93 } },
    });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.resolverNote).toBeNull();
  });

  it("returns a null resolverNote when there is no review_queue row at all", async () => {
    const fixture = await seedVerification({ resolutionPath: "EXTRACTOR_ONLY" });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.resolverNote).toBeNull();
  });
});

describe("getVerificationDetail — bold advisory signal (LH-025/LH-026, TRO-532/TRO-533, TH-R9)", () => {
  it("reads the persisted signal and reason back — the exact shape measureBoldSignal returns", async () => {
    const fixture = await seedVerification({
      boldSignal: {
        signal: "bold",
        reason: "the prefix's stroke width measures wider than the body's",
        ratio: 2.1,
        splitFraction: 0.49,
        prefixStrokeWidthPx: 5,
        bodyStrokeWidthPx: 2.4,
      },
    });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.boldSignal).toEqual({
      signal: "bold",
      reason: "the prefix's stroke width measures wider than the body's",
    });
  });

  it("returns null when no signal was ever measured for this verification (no warning-region crop existed)", async () => {
    const fixture = await seedVerification({ boldSignal: null });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.boldSignal).toBeNull();
  });

  it("degrades to null for a malformed jsonb shape, rather than trusting an untyped column (standing rule 13)", async () => {
    const fixture = await seedVerification({ boldSignal: { signal: "not-a-real-signal-value", reason: "whatever" } });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.boldSignal).toBeNull();
  });

  it("degrades to null when reason is missing, even with a legal signal value", async () => {
    const fixture = await seedVerification({ boldSignal: { signal: "uncertain" } });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.boldSignal).toBeNull();
  });

  it("never surfaces ratio, splitFraction, or stroke-width pixel numbers — the Detail view shows a reason, not a number (standing rule 12)", async () => {
    const fixture = await seedVerification({
      boldSignal: {
        signal: "not-bold",
        reason: "the prefix's stroke width does not measure wider than the body's",
        ratio: 0.9,
        splitFraction: 0.49,
        prefixStrokeWidthPx: 2,
        bodyStrokeWidthPx: 2.2,
      },
    });
    const result = await getVerificationDetail(db, fixture.verificationId);
    if (!result.found) throw new Error("expected found");

    expect(result.detail.boldSignal).toEqual({
      signal: "not-bold",
      reason: "the prefix's stroke width does not measure wider than the body's",
    });
    expect(JSON.stringify(result.detail.boldSignal)).not.toContain("ratio");
  });
});
