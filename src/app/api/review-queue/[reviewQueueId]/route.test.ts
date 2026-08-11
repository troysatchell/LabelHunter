/**
 * `PATCH /api/review-queue/:reviewQueueId` against a real Postgres
 * database — same no-mocking rationale as `src/app/api/verify/route.test.ts`.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../../../lib/db";
import { reviewQueue } from "../../../../lib/db/schema";
import { handleRecordDispositionRequest, type RecordDispositionRouteDeps } from "./route";
import { cleanup, makeQueueItemFixture } from "../test-support";
import type { RecordDispositionConflictResponse, RecordDispositionResponse, ReviewQueueErrorResponse } from "../types";

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
    // A Proxy that throws on any property access — the title's claim is
    // only actually asserted if reaching the database would fail the test
    // loudly, not merely go unobserved (CodeRabbit finding, PR #16 review
    // round 2).
    const untouchedDb = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be touched for a non-integer id");
        },
      },
    ) as RecordDispositionRouteDeps["db"];

    const response = await handleRecordDispositionRequest(patchRequest({ disposition: "APPROVED" }), "not-a-number", { db: untouchedDb });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ReviewQueueErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION on an id above Number.MAX_SAFE_INTEGER, without touching the database", async () => {
    // Number.isInteger alone does not catch precision loss above
    // MAX_SAFE_INTEGER — this digit string would round to a different,
    // smaller integer and silently address the wrong row (CodeRabbit
    // finding, local review round 5).
    const untouchedDb = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be touched for an unsafe id");
        },
      },
    ) as RecordDispositionRouteDeps["db"];

    const response = await handleRecordDispositionRequest(patchRequest({ disposition: "APPROVED" }), "9007199254740993", { db: untouchedDb });
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
