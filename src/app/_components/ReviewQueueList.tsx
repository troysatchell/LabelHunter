/**
 * The review queue's list (TRO-476, PRD §5: "needs-human items with
 * reason"; TH-R22, the differentiator — see CHANGES.md). Purely
 * presentational: it takes the API's response shape as a prop and renders
 * it, the same division `ResultsChecklist.tsx` uses, so it is testable
 * with no network.
 */
import { memo } from "react";
import Link from "next/link";
import { formatTimestampUTC } from "../_lib/format-timestamp";
import type { ReviewQueueListItemWire, ReviewQueueResolverStatus } from "../api/review-queue/types";

export interface ReviewQueueListProps {
  items: ReviewQueueListItemWire[];
}

/**
 * One plain sentence per resolver state (TRO-512, CP-3 §3.3).
 *
 * The resolver's reservation creates a row before Sonnet answers, so a row
 * with no suggestion can mean three different things. Each gets its own
 * sentence, because a reviewer's next action differs: wait a moment, read
 * the label unaided, or open the item and read the suggestion. Naming the
 * state is the same discipline standing rule 12 already applies to a
 * verdict — never show a bare state the reader has to interpret.
 */
const RESOLVER_STATUS_TEXT: Record<ReviewQueueResolverStatus, string> = {
  suggested: "LabelHunter has a suggestion for this item.",
  checking: "LabelHunter is checking this item now. Refresh in a moment.",
  skipped: "LabelHunter did not check this item. Read the label yourself.",
  waiting: "LabelHunter has not checked this item yet.",
};

/** Memoized (TRO-577): the browser's phase transitions ("refreshing",
 * "loading-more") keep the same `items` array reference, so a click on
 * Refresh or Load more mid-scroll re-renders only the status chrome, not
 * every row. */
export const ReviewQueueList = memo(function ReviewQueueList({ items }: ReviewQueueListProps) {
  if (items.length === 0) {
    return <p className="status-banner">No items need review right now.</p>;
  }

  return (
    <ul className="review-queue-list">
      {items.map((item) => (
        <li key={item.id} className="review-queue-row" data-testid={`review-queue-row-${item.id}`}>
          <p className="review-queue-row__reason">{item.reasonText}</p>
          <p className="review-queue-row__context">
            {item.brandName} · {item.classType}
          </p>
          <p className="review-queue-row__waiting">
            Waiting since <time dateTime={item.createdAt}>{formatTimestampUTC(item.createdAt)}</time>
          </p>
          <p className="review-queue-row__resolver" data-resolver-status={item.resolverStatus}>
            {RESOLVER_STATUS_TEXT[item.resolverStatus]}
          </p>
          {/* Every row's link otherwise shares the name "Review this item" —
              a screen-reader user listing the page's links has no way to
              tell rows apart (CodeRabbit finding, PR #16 review round 2).
              The brand name alone does not guarantee uniqueness — two
              applications can share one brand — so the stable item id
              anchors the name too (CodeRabbit finding, local review
              round 9). */}
          {/* prefetch={false} (TRO-577): with the default, every row's
              link prefetches its detail route as it scrolls into the
              viewport — a burst of speculative server renders (DB queries
              included) fired mid-scroll, felt as random hitches. The
              detail page is one deliberate click away; nothing here needs
              to load before that click. */}
          <Link
            href={`/review-queue/${item.id}`}
            prefetch={false}
            className="secondary-button"
            aria-label={`Review this item: ${item.brandName} (#${item.id})`}
          >
            Review this item
          </Link>
        </li>
      ))}
    </ul>
  );
});
