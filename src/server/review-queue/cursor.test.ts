/**
 * The review queue's keyset cursor (TRO-507). Pure functions, no database
 * — the query that uses these positions is tested against real Postgres in
 * `list.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { decodeReviewQueueCursor, encodeReviewQueueCursor, ReviewQueueCursorError } from "./cursor";

describe("review-queue cursor", () => {
  it("round-trips a position exactly", () => {
    const cursor = { createdAt: new Date("2026-08-11T14:03:00.000Z"), id: 42 };
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor(cursor));
    expect(decoded.id).toBe(42);
    expect(decoded.createdAt.toISOString()).toBe("2026-08-11T14:03:00.000Z");
  });

  it("does not leak the position into the URL as readable text", () => {
    const encoded = encodeReviewQueueCursor({ createdAt: new Date(0), id: 7 });
    // Opaque, and URL-safe without further escaping: base64url uses no
    // character a query string would have to encode.
    expect(encoded).not.toContain("|");
    expect(encoded).toBe(encodeURIComponent(encoded));
  });

  it.each([
    ["an empty string", ""],
    ["text with no row id", Buffer.from("2026-08-11T14:03:00.000Z", "utf8").toString("base64url")],
    ["a non-canonical timestamp", Buffer.from("2026-08-11|42", "utf8").toString("base64url")],
    ["a timestamp that is not a date at all", Buffer.from("not-a-date|42", "utf8").toString("base64url")],
    ["a row id of zero", Buffer.from("2026-08-11T14:03:00.000Z|0", "utf8").toString("base64url")],
    ["a negative row id", Buffer.from("2026-08-11T14:03:00.000Z|-3", "utf8").toString("base64url")],
    ["a fractional row id", Buffer.from("2026-08-11T14:03:00.000Z|4.5", "utf8").toString("base64url")],
    ["a row id that is not a number", Buffer.from("2026-08-11T14:03:00.000Z|abc", "utf8").toString("base64url")],
  ])("rejects %s", (_name, encoded) => {
    // Standing rule 13: a cursor is a position this server issued. Anything
    // else is rejected at the boundary, never guessed at.
    expect(() => decodeReviewQueueCursor(encoded)).toThrow(ReviewQueueCursorError);
  });
});
