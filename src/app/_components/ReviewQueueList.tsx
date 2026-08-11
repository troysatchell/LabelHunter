/**
 * The review queue's list (TRO-476, PRD §5: "needs-human items with
 * reason"; TH-R22, the differentiator — see CHANGES.md). Purely
 * presentational: it takes the API's response shape as a prop and renders
 * it, the same division `ResultsChecklist.tsx` uses, so it is testable
 * with no network.
 */
import Link from "next/link";
import { formatTimestampUTC } from "../_lib/format-timestamp";
import type { ReviewQueueListItemWire } from "../api/review-queue/types";

export interface ReviewQueueListProps {
  items: ReviewQueueListItemWire[];
}

export function ReviewQueueList({ items }: ReviewQueueListProps) {
  if (items.length === 0) {
    return <p className="status-banner">No items need review right now.</p>;
  }

  return (
    <ul className="review-queue-list">
      {items.map((item) => (
        <li key={item.id} className="review-queue-row" data-testid={`review-queue-row-${item.id}`}>
          <p className="review-queue-row__reason">{item.reasonText}</p>
          <p className="review-queue-row__context">
            {item.brandName} — {item.classType}
          </p>
          <p className="review-queue-row__waiting">Waiting since {formatTimestampUTC(item.createdAt)}</p>
          <Link href={`/review-queue/${item.id}`} className="secondary-button">
            Review this item
          </Link>
        </li>
      ))}
    </ul>
  );
}
