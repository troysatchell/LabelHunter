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
};

describe("fetchReviewQueue — the happy path", () => {
  it("gets /api/review-queue and returns the items array", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe("/api/review-queue");
      return new Response(JSON.stringify({ items: [SAMPLE_ITEM] }), { status: 200 });
    });

    const items = await fetchReviewQueue({ fetchImpl });
    expect(items).toEqual([SAMPLE_ITEM]);
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
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [SAMPLE_ITEM, malformed] }), { status: 200 }));
    await expect(fetchReviewQueue({ fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
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
});
