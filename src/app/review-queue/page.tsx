/**
 * The review queue's list page (TRO-476, PRD §5, TH-R22 — the
 * differentiator: see CHANGES.md). Kept intentionally thin: the real logic
 * lives in `ReviewQueueBrowser` (data fetching) and `ReviewQueueList`
 * (rendering), both tested on their own — the same division
 * `src/app/page.tsx` (untested, equally thin) already uses for the verify
 * form.
 *
 * TRO-480: before this ticket, this page had no on-page way back to `/` —
 * a reviewer who opened it directly (a bookmark, a shared link) had only
 * the browser's own Back button. The bottom nav link matches
 * `src/app/page.tsx`'s own `.page__nav-links` pattern (TH-R3).
 */
import Link from "next/link";
import { ReviewQueueBrowser } from "../_components/ReviewQueueBrowser";

export default function ReviewQueuePage() {
  return (
    <main className="page">
      <h1 className="page__title">Review queue</h1>
      <p className="page__intro">These labels need a person to look at them. Open one to approve or reject it.</p>
      <ReviewQueueBrowser />
      <p className="page__nav-links">
        <Link href="/" className="secondary-button">
          Verify a label
        </Link>
      </p>
    </main>
  );
}
