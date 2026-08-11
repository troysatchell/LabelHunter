/**
 * The review queue's review/detail page (TRO-476, PRD §5, TH-R22 — the
 * differentiator: see CHANGES.md). A server component, reached from the
 * queue list's own "Review this item" link or a direct URL. It reads the
 * item straight from the database — no client fetch, no loading state.
 *
 * A bad id or an unknown review-queue item calls Next's own `notFound()`,
 * which renders this route segment's `not-found.tsx` and answers with a
 * real 404 status — not a 200 response that merely says "not found" in
 * its body text (TH-R20: a designed error state is an honest status code,
 * not only honest words).
 */
import { notFound } from "next/navigation";
import { db } from "../../../lib/db";
import { getReviewQueueItem } from "../../../server/review-queue";
import { ReviewItemWorkspace } from "../../_components/ReviewItemWorkspace";

export default async function ReviewQueueItemPage({ params }: { params: Promise<{ reviewQueueId: string }> }) {
  const { reviewQueueId: reviewQueueIdRaw } = await params;
  const reviewQueueId = Number(reviewQueueIdRaw);

  if (!Number.isInteger(reviewQueueId) || reviewQueueId <= 0) {
    notFound();
  }

  const result = await getReviewQueueItem(db, reviewQueueId);
  if (!result.found) {
    notFound();
  }

  return (
    <main className="page">
      <h1 className="page__title">Review this label</h1>
      <ReviewItemWorkspace item={result.item} />
    </main>
  );
}
