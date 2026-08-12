/**
 * Renders when `page.tsx` calls `notFound()` for this route segment
 * (LH-042 / TRO-475, TH-R20 — a designed error state, not a generic
 * framework page): a URL segment that is not a valid batch id at all.
 * Mirrors `verify/[verificationId]/not-found.tsx`'s own wording and
 * layout. Plain, honest, with the one obvious way back (TH-R3).
 */
import Link from "next/link";

export default function BatchNotFound() {
  return (
    <main className="page">
      <h1 className="page__title">Batch progress</h1>
      <p className="status-banner">LabelHunter could not read that batch link. Check the link, or start a new batch.</p>
      <p>
        <Link href="/batch" className="secondary-button">
          Start a batch
        </Link>
      </p>
    </main>
  );
}
