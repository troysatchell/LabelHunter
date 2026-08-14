"use client";

/**
 * Next's error boundary for this route (TH-R20 — a designed error state,
 * not the framework's own default page): catches a thrown exception
 * during `page.tsx`'s server render, e.g. a database hiccup while
 * `getVerificationDetail` runs. `notFound()` (this route's `not-found.tsx`)
 * is a different, already-handled case — a missing or malformed id, not a
 * failure. Client Component: Next's own error-boundary contract requires
 * it, so `reset` can re-render the segment without a full page reload.
 */
import Link from "next/link";

export default function VerificationError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page">
      <h1 className="page__title">Label detail</h1>
      <div className="error-panel" role="alert">
        <p className="error-panel__title">Something went wrong</p>
        <p className="error-panel__message">LabelHunter could not load this label. Try again, or go back and verify a label.</p>
        <button type="button" className="secondary-button" onClick={reset}>
          Try again
        </button>
      </div>
      <p>
        <Link href="/" className="secondary-button">
          Verify a label
        </Link>
      </p>
    </main>
  );
}
