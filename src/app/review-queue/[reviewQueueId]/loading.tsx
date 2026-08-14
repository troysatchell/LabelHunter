/**
 * Route-level loading state for the review/detail page (loading-state
 * pass, Troy direct). `page.tsx` here is a server component that queries
 * the database before it can render anything — without this file, Next
 * left the queue list frozen on screen for the whole query after
 * "Review this item" was pressed. Next shows this instantly on
 * navigation.
 *
 * The shell (`.page`, the real h1) matches `page.tsx` exactly, and the
 * skeleton reserves roughly the item layout's space, so the loaded
 * content replaces this in place instead of jumping.
 */
export default function ReviewQueueItemLoading() {
  return (
    <main className="page" aria-busy="true">
      <h1 className="page__title">Review this label</h1>
      <p className="status-banner" role="status">
        <span className="busy-spinner" aria-hidden="true" />
        Loading this item…
      </p>
      <div className="skeleton-stack" aria-hidden="true">
        <div className="skeleton-block skeleton-block--banner" />
        <div className="skeleton-block skeleton-block--row" />
        <div className="skeleton-block skeleton-block--row" />
        <div className="skeleton-block skeleton-block--row" />
        <div className="skeleton-block skeleton-block--row" />
      </div>
    </main>
  );
}
