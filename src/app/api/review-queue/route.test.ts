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
import type { ReviewQueueErrorResponse, ReviewQueueListResponse } from "./types";

const ENDPOINT = "http://localhost/api/review-queue";

function request(query = ""): Request {
  return new Request(`${ENDPOINT}${query}`);
}

describe("GET /api/review-queue", () => {
  it("returns 200 with an unresolved item, and the createdAt travels as an ISO string", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture();
    try {
      const response = await GET(request());
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReviewQueueListResponse;
      const item = body.items.find((row) => row.id === queueId);
      expect(item).toBeDefined();
      expect(item?.brandName).toBe("TRO-476 Test Fixture");
      expect(item?.reasonText.length).toBeGreaterThan(0);
      // TRO-512: the row says what the resolver has done, so a reviewer is
      // never left guessing whether a suggestion is still coming.
      expect(item?.resolverStatus).toBe("waiting");
      // Canonical round-trip, not only "parseable" — matches the same rigor
      // review-queue-client.ts's isCanonicalTimestamp requires on the client
      // side (CodeRabbit finding, local review round 8).
      expect(new Date(item?.createdAt ?? "").toISOString()).toBe(item?.createdAt);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("excludes a disposed item", async () => {
    const { applicationId, queueId } = await makeQueueItemFixture(true);
    try {
      const response = await GET(request());
      const body = (await response.json()) as ReviewQueueListResponse;
      expect(body.items.map((row) => row.id)).not.toContain(queueId);
    } finally {
      await cleanup(applicationId);
    }
  });

  it("answers with a nextCursor, and serves the next page from it (TRO-507)", async () => {
    const first = await makeQueueItemFixture();
    const second = await makeQueueItemFixture();
    try {
      const pageOne = (await (await GET(request("?limit=1"))).json()) as ReviewQueueListResponse;
      expect(pageOne.items).toHaveLength(1);
      expect(pageOne.nextCursor).not.toBeNull();

      // Walk forward until this test's own second row appears. Other test
      // files write to the same queue, so "the very next page" is not
      // guaranteed to be this row — but reachable through the cursor chain
      // is exactly the property this ticket adds.
      let cursor = pageOne.nextCursor;
      const seen: number[] = pageOne.items.map((row) => row.id);
      for (let page = 0; page < 50 && cursor !== null; page += 1) {
        const body = (await (await GET(request(`?limit=1&after=${encodeURIComponent(cursor)}`))).json()) as ReviewQueueListResponse;
        seen.push(...body.items.map((row) => row.id));
        cursor = body.nextCursor;
        if (seen.includes(second.queueId)) break;
      }
      expect(seen).toContain(first.queueId);
      expect(seen).toContain(second.queueId);
      // No page repeated a row it had already served.
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      await cleanup(first.applicationId);
      await cleanup(second.applicationId);
    }
  });

  it.each(["?limit=0", "?limit=-1", "?limit=101", "?limit=abc", "?limit=1.5"])("answers 400 for %s rather than a silently wrong page", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    const body = (await response.json()) as ReviewQueueErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
    // TH-R20: the answer says what is wrong, not just that something is.
    expect(body.error.message).toMatch(/1 through 100/);
  });

  it("answers 400 for a cursor this server never issued", async () => {
    const response = await GET(request("?after=not-a-real-cursor"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as ReviewQueueErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
  });
});
