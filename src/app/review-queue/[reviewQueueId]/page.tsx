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
 *
 * TRO-480: before this ticket, a reviewer who opened an item and decided
 * not to act on it yet had no on-page way back to the list — only
 * `ReviewActions`' own post-decision `router.push("/review-queue")`
 * existed, and that never fires until a decision is recorded. The bottom
 * nav link below matches this route's own `not-found.tsx` wording ("Back
 * to the review queue") so the same destination reads the same way
 * whether the item exists or not.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "../../../lib/db";
import { getReviewQueueItem } from "../../../server/review-queue";
import { ReviewItemWorkspace } from "../../_components/ReviewItemWorkspace";

export default async function ReviewQueueItemPage({ params }: { params: Promise<{ reviewQueueId: string }> }) {
  // `Number.isInteger` alone does not catch precision loss above
  // `Number.MAX_SAFE_INTEGER` — a long enough digit string can round to a
  // different, smaller integer and silently address the wrong row (same
  // class as this session's verify/[verificationId]/page.tsx and
  // review-queue/[reviewQueueId]/route.ts fixes; CodeRabbit finding,
  // local review round 6).
  const { reviewQueueId: reviewQueueIdRaw } = await params;
  const reviewQueueId = Number(reviewQueueIdRaw);

  if (!Number.isSafeInteger(reviewQueueId) || reviewQueueId <= 0) {
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
      <p className="page__nav-links">
        <Link href="/review-queue" className="secondary-button">
          Back to the review queue
        </Link>
      </p>
    </main>
  );
}
