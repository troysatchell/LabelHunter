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
 *
 * **Paging (TRO-507).** The endpoint returns one page and says whether
 * more items follow. This component shows that fact and offers "Load
 * more", which appends the next page. Before this, a queue deeper than 100
 * items showed the first 100 as if they were all of them — a reviewer had
 * no way to know anything was missing, which is the wrong side of
 * TH-R10/TH-R20 ("uncertain beats wrong; always show the reason").
 */
import { useEffect, useState } from "react";
import { fetchReviewQueue, ReviewQueueClientError } from "../_lib/review-queue-client";
import type { ReviewQueueListItemWire, ReviewQueueListResponse } from "../api/review-queue/types";
import { ReviewQueueList } from "./ReviewQueueList";

type Phase =
  | { status: "loading" }
  | { status: "refreshing"; items: ReviewQueueListItemWire[]; nextCursor: string | null }
  | { status: "success"; items: ReviewQueueListItemWire[]; nextCursor: string | null }
  | { status: "loading-more"; items: ReviewQueueListItemWire[]; nextCursor: string }
  | { status: "error"; message: string }
  | {
      status: "refresh-error";
      items: ReviewQueueListItemWire[];
      nextCursor: string | null;
      message: string;
      /** Which control the reviewer actually pressed — the error title
       * must name it, not always claim "refresh" (TH-R20: show the real
       * reason, never a plausible-but-wrong one). */
      source: "refresh" | "load-more";
    };

export interface ReviewQueueBrowserProps {
  /** Injected in tests; defaults to the real network call. `after` reads
   * the page following that cursor. */
  fetchItems?: (after?: string) => Promise<ReviewQueueListResponse>;
}

const DEFAULT_ERROR_MESSAGE = "LabelHunter could not load the review queue. Try again.";

function messageFor(error: unknown): string {
  return error instanceof ReviewQueueClientError ? error.message : DEFAULT_ERROR_MESSAGE;
}

function defaultFetchItems(after?: string): Promise<ReviewQueueListResponse> {
  return fetchReviewQueue({ after });
}

export function ReviewQueueBrowser({ fetchItems = defaultFetchItems }: ReviewQueueBrowserProps) {
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [requestId, setRequestId] = useState(0);
  /** The persistent live line's settled text ("The review queue is up to
   * date.", "Loaded 3 more items."). In-flight text is derived from
   * `phase` directly; this only holds what to say once a request the
   * reviewer started has finished. Cleared on failure — the role="alert"
   * panels announce failures themselves. */
  const [announcement, setAnnouncement] = useState("");

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
      (page) => {
        if (cancelled) return;
        setPhase({ status: "success", items: page.items, nextCursor: page.nextCursor });
        // requestId 0 is the first, automatic load — nothing to announce
        // there beyond the page itself. Any bump comes from a control the
        // reviewer pressed (Refresh, Try again), and THAT completion is
        // otherwise silent to assistive tech.
        if (requestId > 0) setAnnouncement("The review queue is up to date.");
      },
      (error: unknown) => {
        if (cancelled) return;
        setAnnouncement("");
        // A failed manual refresh keeps the rows on screen, next to the
        // error, instead of replacing a working list with a bare error
        // panel — the same reason `refresh()` below keeps rows mounted
        // while the request is in flight (CodeRabbit finding, local
        // review round 3).
        setPhase((current) =>
          current.status === "refreshing"
            ? { status: "refresh-error", items: current.items, nextCursor: current.nextCursor, message: messageFor(error), source: "refresh" }
            : { status: "error", message: messageFor(error) },
        );
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
    // review round 2). Retrying after a failed refresh must keep the rows
    // too, not only a successful refresh — the first version of this fix
    // checked only "success" (CodeRabbit finding, local review round 4).
    setPhase((current) =>
      current.status === "success" || current.status === "refresh-error"
        ? { status: "refreshing", items: current.items, nextCursor: current.nextCursor }
        : { status: "loading" },
    );
    setRequestId((id) => id + 1);
  }

  // A refresh restarts the queue from its first page, so the reviewer
  // never ends up with page 3 of a queue that has since changed. Loading
  // more, by contrast, APPENDS: the rows already read stay put.
  //
  // Every state update below is guarded on this request's own cursor still
  // being the one in flight, so a refresh started while a page was loading
  // wins and the late page is discarded rather than appended to a list it
  // no longer belongs to.
  //
  // "refresh-error" runs this too, not only "success". That state holds a
  // real cursor — a failed page load keeps the cursor it failed on, and a
  // failed refresh keeps the last good page's cursor — and the UI already
  // renders "Load more" for it. Accepting only "success" left that button
  // on screen, enabled, doing nothing (CodeRabbit finding, local review
  // round 6). The retry reuses the same cursor, so the page the reviewer
  // never received is the page that is asked for again.
  function loadMore() {
    if (phase.status !== "success" && phase.status !== "refresh-error") return;
    if (phase.nextCursor === null) return;
    const cursor = phase.nextCursor;
    setPhase({ status: "loading-more", items: phase.items, nextCursor: cursor });
    fetchItems(cursor).then(
      (page) => {
        setPhase((latest) =>
          latest.status === "loading-more" && latest.nextCursor === cursor
            ? { status: "success", items: [...latest.items, ...page.items], nextCursor: page.nextCursor }
            : latest,
        );
        // Announced without the updater's own applied/discarded guard —
        // an updater must stay a pure function, and in the one race where
        // a refresh superseded this page, the refresh writes its own
        // announcement right after anyway.
        setAnnouncement(page.items.length === 1 ? "Loaded 1 more item." : `Loaded ${page.items.length} more items.`);
      },
      (error: unknown) => {
        setAnnouncement("");
        setPhase((latest) =>
          latest.status === "loading-more" && latest.nextCursor === cursor
            ? { status: "refresh-error", items: latest.items, nextCursor: cursor, message: messageFor(error), source: "load-more" }
            : latest,
        );
      },
    );
  }

  if (phase.status === "loading") {
    return (
      <>
        {/* The status line stays OUTSIDE the aria-busy region: aria-busy
            lets assistive tech withhold changes inside the busy region
            until it clears (WAI-ARIA), and this line is the one
            announcement the first load makes. */}
        <p className="status-banner" role="status">
          <span className="busy-spinner" aria-hidden="true" />
          Loading the review queue…
        </p>
        <div aria-busy="true">
          {/* Placeholder rows reserve roughly the space the real list takes,
              so the loaded rows land without a large layout jump.
              aria-hidden: the status line above is the announcement. */}
          <ul className="review-queue-list" aria-hidden="true">
            <li className="review-queue-row skeleton-row" />
            <li className="review-queue-row skeleton-row" />
            <li className="review-queue-row skeleton-row" />
          </ul>
        </div>
      </>
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
  const isLoadingMore = phase.status === "loading-more";
  const hasMore = phase.nextCursor !== null;

  return (
    <>
      {/* One persistent polite line, present from this branch's first
          render, not a new region mounted per state (a live region only
          reliably announces content ADDED after it exists in the DOM —
          the same WAI-ARIA reasoning VerifyForm's results region
          documents): in-flight text while a request the reviewer started
          runs, then its settled outcome. OUTSIDE the aria-busy region
          below — aria-busy lets assistive tech withhold changes inside
          the busy region until it clears (WAI-ARIA), which would silence
          exactly the in-flight text this line exists to announce.
          Visually hidden — the buttons and rows already show all of
          this. */}
      <p className="visually-hidden" role="status" data-testid="review-queue-live-status">
        {isRefreshing ? "Refreshing the review queue…" : isLoadingMore ? "Loading more items…" : announcement}
      </p>
      <div aria-busy={isRefreshing || isLoadingMore}>
        <button type="button" className="secondary-button" disabled={isRefreshing || isLoadingMore} onClick={refresh}>
          {isRefreshing ? (
            <>
              <span className="busy-spinner" aria-hidden="true" />
              Refreshing…
            </>
          ) : (
            "Refresh"
          )}
        </button>
        {phase.status === "refresh-error" && (
          <div className="error-panel" role="alert">
            <p className="error-panel__title">
              {phase.source === "load-more" ? "Could not load more items" : "Could not refresh the review queue"}
            </p>
            <p className="error-panel__message">{phase.message}</p>
          </div>
        )}
        <ReviewQueueList items={phase.items} />
        {hasMore && (
          <div className="review-queue-more">
            {/* The list on screen is not the whole queue. Say so plainly,
                next to the control that reads the rest — a reviewer must
                never have to work out that items are missing (TH-R3: no
                instructions needed; TH-R20: always show the reason). */}
            {/* No `role="status"`: this line states a standing fact a
                reviewer reads in place, and the one persistent status
                line above now owns every announcement. With both live,
                one "Load more" announced twice at once — the new "Loaded
                N more items." and this line's own changed count. */}
            <p className="review-queue-more__notice">
              You are seeing the {phase.items.length} oldest items. More items are waiting.
            </p>
            <button type="button" className="secondary-button" disabled={isLoadingMore || isRefreshing} onClick={loadMore}>
              {isLoadingMore ? (
                <>
                  <span className="busy-spinner" aria-hidden="true" />
                  Loading more…
                </>
              ) : (
                "Load more"
              )}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
