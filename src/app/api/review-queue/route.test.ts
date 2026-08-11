/**
 * `GET /api/review-queue` against a real Postgres database — same
 * no-mocking rationale as `src/app/api/verify/route.test.ts`. Every
 * assertion filters the response down to rows this test itself created, by
 * id (see `src/server/review-queue/list.test.ts`'s file comment: this
 * suite shares one worktree database with every other `*.test.ts` file).
 */
import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { cleanup, makeQueueItemFixture } from "./test-support";
import type { ReviewQueueListResponse } from "./types";

describe("GET /api/review-queue", () => {
  it("returns 200 with an unresolved item, and the createdAt travels as an ISO string", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const response = await GET();
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReviewQueueListResponse;
      const item = body.items.find((row) => row.id === queueId);
      expect(item).toBeDefined();
      expect(item?.brandName).toBe("Old Tom Distillery");
      expect(item?.reasonText.length).toBeGreaterThan(0);
      expect(typeof item?.createdAt).toBe("string");
      expect(() => new Date(item?.createdAt ?? "")).not.toThrow();
      expect(Number.isNaN(new Date(item?.createdAt ?? "").getTime())).toBe(false);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("excludes a disposed item", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture(true);
    try {
      const response = await GET();
      const body = (await response.json()) as ReviewQueueListResponse;
      expect(body.items.map((row) => row.id)).not.toContain(queueId);
    } finally {
      await cleanup(applicationId);
    }
  });
});
