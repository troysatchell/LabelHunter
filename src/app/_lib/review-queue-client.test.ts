import { describe, expect, it, vi } from "vitest";
import { fetchReviewQueue, ReviewQueueClientError, submitDisposition } from "./review-queue-client";
import type { ReviewQueueListItemWire } from "../api/review-queue/types";

const SAMPLE_ITEM: ReviewQueueListItemWire = {
  id: 1,
  verificationId: 10,
  applicationId: 20,
  reason: "AMBIGUOUS_BRAND",
  reasonText: "A reviewer must check the brand name or class and type against the label.",
  brandName: "Old Tom Distillery",
  classType: "Straight Bourbon Whiskey",
  beverageType: "spirits",
  labelVerdict: "REVIEW",
  createdAt: "2026-08-11T12:00:00.000Z",
  resolverStatus: "waiting",
};

describe("fetchReviewQueue — the happy path", () => {
  it("gets /api/review-queue and returns one page", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe("/api/review-queue");
      return new Response(JSON.stringify({ items: [SAMPLE_ITEM], nextCursor: null }), { status: 200 });
    });

    const page = await fetchReviewQueue({ fetchImpl });
    expect(page.items).toEqual([SAMPLE_ITEM]);
    expect(page.nextCursor).toBeNull();
  });

  it("asks for the next page when given a cursor, and carries the cursor back (TRO-507)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe("/api/review-queue?after=cursor%2Fone");
      return new Response(JSON.stringify({ items: [SAMPLE_ITEM], nextCursor: "cursor/two" }), { status: 200 });
    });

    const page = await fetchReviewQueue({ fetchImpl, after: "cursor/one" });
    expect(page.nextCursor).toBe("cursor/two");
  });

  it("rejects a 200 body with no nextCursor at all — a missing cursor is not the same fact as null", async () => {
    // Without this check, a client would read a partial page as the whole
    // queue: exactly the failure TRO-507 exists to end.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [SAMPLE_ITEM] }), { status: 200 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("rejects a 200 body with no items but a cursor that promises more (TRO-507)", async () => {
    // `list.ts` builds `nextCursor` from the last item of the page it just
    // returned, so "no items" and "more items follow" cannot both be true.
    // A body claiming both would loop the browser forever on a page that
    // never grows (CodeRabbit finding, local review round 6).
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: "cursor/two" }), { status: 200 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("accepts an empty page that ends the queue", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
    const page = await fetchReviewQueue({ fetchImpl });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("rejects a 200 body whose item carries an unknown resolver status (TRO-512)", async () => {
    const malformed = { ...SAMPLE_ITEM, resolverStatus: "NOT_A_REAL_STATUS" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [malformed], nextCursor: null }), { status: 200 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });
});

describe("fetchReviewQueue — designed error states", () => {
  it("classifies a non-2xx response with a structured error body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { kind: "SERVICE", message: "Try again." } }), { status: 503 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE", message: "Try again." });
  });

  it("classifies a network failure as SERVICE", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toBeInstanceOf(ReviewQueueClientError);
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("does not trust a 200 body with no items array", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("does not trust a 200 body whose items array contains one malformed entry — CodeRabbit local review round 1", async () => {
    // Only the array's own shape was checked before this fix — a real item
    // next to a malformed one (a bad enum value here) passed through
    // whole. Every entry must now individually match ReviewQueueListItemWire.
    const malformed = { ...SAMPLE_ITEM, reason: "NOT_A_REAL_REASON" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [SAMPLE_ITEM, malformed], nextCursor: null }), { status: 200 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("does not trust a 200 item whose createdAt is a string but not a parseable timestamp — PR #16 review round 2", async () => {
    // `typeof === "string"` alone let server drift through; formatTimestampUTC
    // (`new Date(value)`) would have silently rendered "Invalid Date UTC".
    const badTimestamp = { ...SAMPLE_ITEM, createdAt: "not-a-date" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [badTimestamp], nextCursor: null }), { status: 200 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("does not trust a 200 item whose createdAt parses but is not the server's own canonical toISOString() form — local review round 3", async () => {
    // "2026-08-11" parses fine (midnight UTC) but the server never sends
    // this shape — only its own `.toISOString()` output. Accepting a
    // merely-parseable value here would hide real client/server drift
    // instead of catching it.
    const nonCanonical = { ...SAMPLE_ITEM, createdAt: "2026-08-11" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [nonCanonical], nextCursor: null }), { status: 200 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("aborts and reports a timeout when the server never responds in time", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    await expect(fetchReviewQueue({ fetchImpl, timeoutMs: 15 })).rejects.toMatchObject({
      kind: "SERVICE",
      message: expect.stringMatching(/took too long/i),
    });
  });
});

describe("submitDisposition — the happy path", () => {
  it("PATCHes /api/review-queue/:id with a JSON disposition body", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("/api/review-queue/7");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init?.body as string)).toEqual({ disposition: "APPROVED" });
      return new Response(JSON.stringify({ id: 7, disposition: "APPROVED", disposedAt: "2026-08-11T12:00:00.000Z" }), { status: 200 });
    });

    const result = await submitDisposition(7, "APPROVED", { fetchImpl });
    expect(result).toEqual({ id: 7, disposition: "APPROVED", disposedAt: "2026-08-11T12:00:00.000Z" });
  });
});

describe("submitDisposition — designed error states", () => {
  it("classifies a 404 as NOT_FOUND", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { kind: "NOT_FOUND", message: "Gone." } }), { status: 404 }));
    await expect(submitDisposition(7, "APPROVED", { fetchImpl })).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("classifies a 409 as CONFLICT and carries the disposition that already won", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { kind: "CONFLICT", message: "Someone already recorded a decision on this item." },
            disposition: "REJECTED",
            disposedAt: "2026-08-11T12:00:00.000Z",
          }),
          { status: 409 },
        ),
    );

    await expect(submitDisposition(7, "APPROVED", { fetchImpl })).rejects.toMatchObject({
      kind: "CONFLICT",
      conflictDisposition: "REJECTED",
    });
  });

  it("does not trust an error body whose kind is outside REVIEW_QUEUE_ERROR_KINDS — falls back to SERVICE", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { kind: "BOGUS", message: "x" } }), { status: 422 }));
    await expect(submitDisposition(7, "APPROVED", { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("classifies a 409 with no disposition field as CONFLICT without conflictDisposition", async () => {
    // `isRecordDispositionConflictResponse` rejects a body missing
    // `disposition`; `isReviewQueueErrorResponse` then matches it instead,
    // so the client must still throw CONFLICT (just without the specific
    // disposition), not fall through to a generic SERVICE error.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { kind: "CONFLICT", message: "Already decided." } }), { status: 409 }));
    await expect(submitDisposition(7, "APPROVED", { fetchImpl })).rejects.toMatchObject({
      kind: "CONFLICT",
      conflictDisposition: undefined,
    });
  });

  it("does not trust a 200 response whose disposedAt is a string but not a parseable timestamp — PR #16 review round 2", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: 7, disposition: "APPROVED", disposedAt: "not-a-date" }), { status: 200 }),
    );
    await expect(submitDisposition(7, "APPROVED", { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("does not trust a 200 response whose id is not a positive integer — local review round 3", async () => {
    // The list response's items already required this (isPositiveInteger,
    // matching the server route's own contract); this response shape had
    // been left on the weaker typeof === "number" check.
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: -1, disposition: "APPROVED", disposedAt: "2026-08-11T12:00:00.000Z" }), { status: 200 }),
    );
    await expect(submitDisposition(7, "APPROVED", { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("does not trust a 200 response for a different item than the one requested — local review round 5", async () => {
    // A well-formed, valid-shaped response about the wrong id is exactly
    // as unsafe to return as a malformed one.
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: 99, disposition: "APPROVED", disposedAt: "2026-08-11T12:00:00.000Z" }), { status: 200 }),
    );
    await expect(submitDisposition(7, "APPROVED", { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("aborts and reports a timeout when the server never responds in time", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    await expect(submitDisposition(7, "APPROVED", { fetchImpl, timeoutMs: 15 })).rejects.toMatchObject({
      kind: "SERVICE",
      message: expect.stringMatching(/took too long/i),
    });
  });

  it("still reports a timeout when the response resolves immediately but the body never finishes parsing", async () => {
    // Clearing the timer right after `fetch()` resolves would leave a
    // hanging `.json()` read with no timeout protection at all (CodeRabbit
    // finding, local review round 2) — the timer must stay live through
    // the body read too.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolve({
            ok: true,
            json: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  const err = new Error("aborted");
                  err.name = "AbortError";
                  reject(err);
                });
              }),
          } as Response);
        }),
    );

    await expect(submitDisposition(7, "APPROVED", { fetchImpl, timeoutMs: 15 })).rejects.toMatchObject({
      kind: "SERVICE",
      message: expect.stringMatching(/took too long/i),
    });
  });
});
