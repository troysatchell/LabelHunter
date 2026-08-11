"use client";

/**
 * The review queue's list page's data-fetching wrapper (TRO-476, PRD §5).
 * Fetches `GET /api/review-queue` on mount, the same `Phase` state-machine
 * pattern `VerifyForm.tsx` uses for its own request. A manual "Refresh"
 * lets a reviewer working through several items in one sitting see a newly
 * escalated item without navigating away and back — small, and not asked
 * for by the PRD line verbatim, but a queue a reviewer can churn through
 * smoothly is the kind of thing TH-R22 asks this ticket to name as a
 * differentiator, not bury.
 */
import { useEffect, useState } from "react";
import { fetchReviewQueue, ReviewQueueClientError } from "../_lib/review-queue-client";
import type { ReviewQueueListItemWire } from "../api/review-queue/types";
import { ReviewQueueList } from "./ReviewQueueList";

type Phase =
  | { status: "loading" }
  | { status: "refreshing"; items: ReviewQueueListItemWire[] }
  | { status: "success"; items: ReviewQueueListItemWire[] }
  | { status: "error"; message: string };

export interface ReviewQueueBrowserProps {
  /** Injected in tests; defaults to the real network call. */
  fetchItems?: () => Promise<ReviewQueueListItemWire[]>;
}

export function ReviewQueueBrowser({ fetchItems = fetchReviewQueue }: ReviewQueueBrowserProps) {
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [requestId, setRequestId] = useState(0);

  // `phase` starts as `{ status: "loading" }` (the `useState` initializer
  // above), which covers the first mount. `refresh` below sets it back to
  // "loading" itself, synchronously, in the click handler that bumps
  // `requestId` — not inside this effect. Setting state directly in an
  // effect body causes a second, avoidable render (React's own
  // `react-hooks/set-state-in-effect` rule); this effect only ever sets
  // state from the fetch's own resolution, an external event, which is
  // exactly what an effect is for.
  useEffect(() => {
    let cancelled = false;
    fetchItems().then(
      (items) => {
        if (!cancelled) setPhase({ status: "success", items });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof ReviewQueueClientError ? error.message : "LabelHunter could not load the review queue. Try again.";
        setPhase({ status: "error", message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [requestId, fetchItems]);

  function refresh() {
    // Keep the current rows mounted during a manual refresh — swapping to
    // the bare "loading" state here unmounted the whole list and threw
    // away the reviewer's scroll position on every refresh, defeating the
    // point of this control (this file's own comment above: "a queue a
    // reviewer can churn through smoothly") (CodeRabbit finding, PR #16
    // review round 2).
    setPhase((current) => (current.status === "success" ? { status: "refreshing", items: current.items } : { status: "loading" }));
    setRequestId((id) => id + 1);
  }

  if (phase.status === "loading") {
    return (
      <p className="status-banner" role="status">
        Loading the review queue…
      </p>
    );
  }

  if (phase.status === "error") {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel__title">Could not load the review queue</p>
        <p className="error-panel__message">{phase.message}</p>
        <button type="button" className="secondary-button" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  }

  const isRefreshing = phase.status === "refreshing";

  return (
    <>
      <button type="button" className="secondary-button" disabled={isRefreshing} onClick={refresh}>
        {isRefreshing ? "Refreshing…" : "Refresh"}
      </button>
      <ReviewQueueList items={phase.items} />
    </>
  );
}
