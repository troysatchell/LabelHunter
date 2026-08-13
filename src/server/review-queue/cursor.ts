/**
 * The review queue's keyset cursor (TRO-507).
 *
 * The list query orders by `(createdAt, id)` — the pair the partial index
 * `review_queue_unresolved_idx` and a deterministic tiebreaker already give
 * it (`list.ts`). A cursor names one exact position in that order, so
 * "the next page" means "everything after this row", not "skip N rows".
 *
 * **Why a keyset cursor and not OFFSET.** The queue is written while it is
 * read. A reviewer disposing of an item, or a batch escalating a new one,
 * shifts every OFFSET-based page boundary underneath the reader — a row
 * moves from page 2 to page 1 and the reviewer never sees it. A keyset
 * cursor is anchored to a row's own sort key, so a concurrent insert or
 * delete cannot make a row skip a page. That matters more here than
 * usual: TH-R10/TH-R20 ask this queue never to look complete when it is
 * not, and a silently skipped item is the same failure in a different
 * place.
 *
 * The encoded form is opaque on purpose (base64url). A cursor is a
 * position this server issued, not an API parameter a caller composes —
 * `decodeReviewQueueCursor` rejects anything it did not plausibly write.
 */

/** One exact position in the `(createdAt, id)` order. */
export interface ReviewQueueCursor {
  createdAt: Date;
  id: number;
}

/** A cursor a caller sent that this server could not have issued. Its own
 * class so a route can answer 400 (the caller's input is wrong) instead of
 * 503 (the server is broken). */
export class ReviewQueueCursorError extends Error {
  constructor(reason: string) {
    super(`The review-queue cursor is not valid: ${reason}`);
    this.name = "ReviewQueueCursorError";
  }
}

/** Encodes one position as an opaque string. */
export function encodeReviewQueueCursor(cursor: ReviewQueueCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decodes a cursor a caller sent back, or throws `ReviewQueueCursorError`.
 *
 * Standing rule 13: name the real invariant and check it. The invariant is
 * "this is a position this server issued" — a canonical
 * `Date.prototype.toISOString()` timestamp (the same round-trip check
 * `src/app/_lib/review-queue-client.ts` requires of every timestamp on the
 * wire) and a positive integer row id. Merely "parses as a date" is not
 * enough: it would let a caller widen the page boundary in ways this
 * server's own ordering never produces.
 */
export function decodeReviewQueueCursor(encoded: string): ReviewQueueCursor {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new ReviewQueueCursorError("it is empty.");
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new ReviewQueueCursorError("it is not base64url text.");
  }

  const separator = decoded.lastIndexOf("|");
  if (separator === -1) {
    throw new ReviewQueueCursorError("it does not carry both a timestamp and a row id.");
  }

  const timestamp = decoded.slice(0, separator);
  const rawId = decoded.slice(separator + 1);
  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== timestamp) {
    throw new ReviewQueueCursorError("its timestamp is not a canonical ISO-8601 instant.");
  }

  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ReviewQueueCursorError("its row id is not a positive integer.");
  }

  return { createdAt, id };
}
