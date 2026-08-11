/**
 * Renders when `page.tsx` calls `notFound()` for this route segment
 * (TRO-476, TH-R20 — a designed error state, not a generic framework
 * page): a bad id, or a review-queue item that does not exist. Plain,
 * honest wording, with the one obvious way back (TH-R3).
 */
import Link from "next/link";

export default function ReviewQueueItemNotFound() {
  return (
    <main className="page">
      <h1 className="page__title">Review this label</h1>
      <p className="status-banner">LabelHunter could not find a review-queue item with that ID. It may not exist, or the link may be wrong.</p>
      <p>
        <Link href="/review-queue" className="secondary-button">
          Back to the review queue
        </Link>
      </p>
    </main>
  );
}
