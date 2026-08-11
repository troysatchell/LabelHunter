/**
 * `PATCH /api/review-queue/:reviewQueueId` against a real Postgres
 * database — same no-mocking rationale as `src/app/api/verify/route.test.ts`.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../../../lib/db";
import { applications, labelImages, reviewQueue, verifications } from "../../../../lib/db/schema";
import { handleRecordDispositionRequest } from "./route";
import type { RecordDispositionConflictResponse, RecordDispositionResponse, ReviewQueueErrorResponse } from "../types";

async function makeQueueItemFixture() {
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
    .values({ verificationId: verification.id, reason: "AMBIGUOUS_BRAND" })
    .returning();
  return { applicationId: application.id, queueId: queueRow.id };
}

async function cleanup(applicationId: number) {
  await db.delete(applications).where(eq(applications.id, applicationId));
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/review-queue/1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/review-queue/:reviewQueueId", () => {
  it("records APPROVED, returns 200 with the disposition and an ISO disposedAt", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const response = await handleRecordDispositionRequest(patchRequest({ disposition: "APPROVED" }), String(queueId));
      expect(response.status).toBe(200);
      const body = (await response.json()) as RecordDispositionResponse;
      expect(body.id).toBe(queueId);
      expect(body.disposition).toBe("APPROVED");
      expect(typeof body.disposedAt).toBe("string");
      expect(Number.isNaN(new Date(body.disposedAt).getTime())).toBe(false);

      const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, queueId));
      expect(row.disposition).toBe("APPROVED");
      expect(row.disposedAt).not.toBeNull();
    } finally {
      await cleanup(applicationId);
    }
  });

  it("records REJECTED, returns 200", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const response = await handleRecordDispositionRequest(patchRequest({ disposition: "REJECTED" }), String(queueId));
      expect(response.status).toBe(200);
      const body = (await response.json()) as RecordDispositionResponse;
      expect(body.disposition).toBe("REJECTED");
    } finally {
      await cleanup(applicationId);
    }
  });

  it("returns 400 VALIDATION on an invalid disposition value", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const response = await handleRecordDispositionRequest(patchRequest({ disposition: "MAYBE" }), String(queueId));
      expect(response.status).toBe(400);
      const body = (await response.json()) as ReviewQueueErrorResponse;
      expect(body.error.kind).toBe("VALIDATION");
    } finally {
      await cleanup(applicationId);
    }
  });

  it("returns 400 VALIDATION on a malformed JSON body", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const badRequest = new Request("http://localhost/api/review-queue/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      const response = await handleRecordDispositionRequest(badRequest, String(queueId));
      expect(response.status).toBe(400);
      const body = (await response.json()) as ReviewQueueErrorResponse;
      expect(body.error.kind).toBe("VALIDATION");
    } finally {
      await cleanup(applicationId);
    }
  });

  it("returns 400 VALIDATION on a non-integer id, without touching the database", async () => {
    const response = await handleRecordDispositionRequest(patchRequest({ disposition: "APPROVED" }), "not-a-number");
    expect(response.status).toBe(400);
    const body = (await response.json()) as ReviewQueueErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
  });

  it("returns 404 NOT_FOUND for a nonexistent id", async () => {
    const response = await handleRecordDispositionRequest(patchRequest({ disposition: "APPROVED" }), "999999999");
    expect(response.status).toBe(404);
    const body = (await response.json()) as ReviewQueueErrorResponse;
    expect(body.error.kind).toBe("NOT_FOUND");
  });

  it("returns 409 CONFLICT on a second disposition, carrying the disposition that already won", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const first = await handleRecordDispositionRequest(patchRequest({ disposition: "APPROVED" }), String(queueId));
      expect(first.status).toBe(200);

      const second = await handleRecordDispositionRequest(patchRequest({ disposition: "REJECTED" }), String(queueId));
      expect(second.status).toBe(409);
      const body = (await second.json()) as RecordDispositionConflictResponse;
      expect(body.error.kind).toBe("CONFLICT");
      expect(body.disposition).toBe("APPROVED");

      // The second call's REJECTED never won.
      const [row] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, queueId));
      expect(row.disposition).toBe("APPROVED");
    } finally {
      await cleanup(applicationId);
    }
  });
});
