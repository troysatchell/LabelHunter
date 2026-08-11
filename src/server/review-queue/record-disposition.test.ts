/**
 * `recordDisposition` against a real Postgres database — same fixture and
 * cleanup discipline as this directory's other suites. Every fixture is
 * looked up by its own id.
 *
 * The last two `describe` blocks exist because the schema's own CHECK
 * constraint (`review_queue_disposition_disposed_at_consistency`,
 * `schema.ts`) is exactly the kind of guarantee a caller must not be
 * trusted to keep by convention alone — TRO-476's brief asks for a test
 * that tries to violate it directly (bypassing `recordDisposition`
 * entirely) and confirms the DATABASE itself rejects it, not just this
 * module's own guarded write path.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { applications, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import { recordDisposition } from "./record-disposition";

async function makeQueueItemFixture() {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
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

  const [queueRow] = await db
    .insert(reviewQueue)
    .values({ verificationId: verification.id, reason: "AMBIGUOUS_BRAND" })
    .returning();

  return { applicationId: application.id, queueId: queueRow.id };
}

async function cleanup(applicationId: number) {
  await db.delete(applications).where(eq(applications.id, applicationId));
}

/**
 * Drizzle's `node-postgres` driver wraps a failed query in its own error
 * whose top-level `.message` is just "Failed query: …" — the real Postgres
 * error (constraint name, SQLSTATE `23514` for a CHECK violation) lives on
 * `.cause` (confirmed by inspecting a real thrown error against this
 * worktree's database before writing this helper, not assumed). Asserting
 * on `.cause.constraint` is the precise, non-regex-fragile check.
 *
 * The "nothing threw" error is thrown AFTER the try/catch, not inside it
 * (CodeRabbit local review round 1): the first draft threw that error
 * inside the same `try` block guarding `await promise`, so its own catch
 * caught its own "nothing threw" error and reported a confusing "expected
 * undefined to be '23514'" instead of the intended message — a test that
 * did not fail for the right reason (standing rule 6).
 */
async function expectCheckConstraintViolation(promise: Promise<unknown>, constraintName: string): Promise<void> {
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (err) {
    const cause = err instanceof Error ? (err.cause as { code?: string; constraint?: string } | undefined) : undefined;
    expect(cause?.code).toBe("23514");
    expect(cause?.constraint).toBe(constraintName);
  }
  if (resolved) {
    throw new Error(`expected a rejection carrying constraint "${constraintName}", but nothing threw`);
  }
}

describe("expectCheckConstraintViolation — the helper itself, not the database", () => {
  it("reports 'nothing threw', not a confusing undefined-cause assertion, when the promise resolves", async () => {
    await expect(expectCheckConstraintViolation(Promise.resolve("no rejection here"), "some_constraint")).rejects.toThrow(
      'expected a rejection carrying constraint "some_constraint", but nothing threw',
    );
  });
});

describe("recordDisposition — real database", () => {
  it("records APPROVED and sets disposedAt together", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const outcome = await recordDisposition(db, queueId, "APPROVED");
      expect(outcome.status).toBe("recorded");
      if (outcome.status !== "recorded") throw new Error("expected recorded");
      expect(outcome.disposition).toBe("APPROVED");
      expect(outcome.disposedAt).toBeInstanceOf(Date);

      const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, queueId));
      expect(row.disposition).toBe("APPROVED");
      expect(row.disposedAt).not.toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });

  it("records REJECTED and sets disposedAt together", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const outcome = await recordDisposition(db, queueId, "REJECTED");
      expect(outcome.status).toBe("recorded");
      if (outcome.status !== "recorded") throw new Error("expected recorded");
      expect(outcome.disposition).toBe("REJECTED");

      const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, queueId));
      expect(row.disposition).toBe("REJECTED");
      expect(row.disposedAt).not.toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });

  it("returns not-found for a nonexistent id", async () => {
    const outcome = await recordDisposition(db, 999_999_999, "APPROVED");
    expect(outcome).toEqual({ status: "not-found" });
  });

  it("returns already-disposed on a second call, and does not overwrite the first disposedAt", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const first = await recordDisposition(db, queueId, "APPROVED");
      if (first.status !== "recorded") throw new Error("expected recorded");

      const second = await recordDisposition(db, queueId, "REJECTED");
      expect(second.status).toBe("already-disposed");
      if (second.status !== "already-disposed") throw new Error("expected already-disposed");
      // The FIRST disposition stands — a second call never clobbers it.
      expect(second.disposition).toBe("APPROVED");
      expect(second.disposedAt.getTime()).toBe(first.disposedAt.getTime());

      const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, queueId));
      expect(row.disposition).toBe("APPROVED");
    } finally {
      await cleanup(applicationId);
    }
  });
});

describe("review_queue_disposition_disposed_at_consistency — the database itself enforces this, not just recordDisposition", () => {
  it("rejects a row where disposition is set but disposedAt is left null", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      // Bypasses recordDisposition entirely — this is the guarantee the
      // CHECK constraint gives even against a caller that does not go
      // through this module's guarded write path at all.
      await expectCheckConstraintViolation(
        db.update(reviewQueue).set({ disposition: "APPROVED" }).where(eq(reviewQueue.id, queueId)),
        "review_queue_disposition_disposed_at_consistency",
      );
    } finally {
      await cleanup(applicationId);
    }
  });

  it("rejects a row where disposedAt is set but disposition is left null", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      await expectCheckConstraintViolation(
        db.update(reviewQueue).set({ disposedAt: new Date() }).where(eq(reviewQueue.id, queueId)),
        "review_queue_disposition_disposed_at_consistency",
      );
    } finally {
      await cleanup(applicationId);
    }
  });

  it("rejects an INSERT that sets disposition without disposedAt, not just an UPDATE", async () => {
    const [application] = await db
      .insert(applications)
      .values({ beverageType: "spirits", brandName: "x", classType: "y", netContentsValue: 750, netContentsUnit: "mL" })
      .returning();
    try {
      const [labelImage] = await db
        .insert(labelImages)
        .values({ applicationId: application.id, storagePath: "x", originalFilename: "x.jpg", widthPx: 1, heightPx: 1 })
        .returning();
      const [verification] = await db
        .insert(verifications)
        .values({ applicationId: application.id, labelImageId: labelImage.id, verdict: "REVIEW", resolutionPath: "EXTRACTOR_ONLY" })
        .returning();

      await expectCheckConstraintViolation(
        db.insert(reviewQueue).values({ verificationId: verification.id, reason: "AMBIGUOUS_BRAND", disposition: "APPROVED" }),
        "review_queue_disposition_disposed_at_consistency",
      );
    } finally {
      await cleanup(application.id);
    }
  });
});
