/**
 * The review queue's list page (TRO-476, PRD §5, TH-R22 — the
 * differentiator: see CHANGES.md). Kept intentionally thin: the real logic
 * lives in `ReviewQueueBrowser` (data fetching) and `ReviewQueueList`
 * (rendering), both tested on their own — the same division
 * `src/app/page.tsx` (untested, equally thin) already uses for the verify
 * form.
 */
import { ReviewQueueBrowser } from "../_components/ReviewQueueBrowser";

export default function ReviewQueuePage() {
  return (
    <main className="page">
      <h1 className="page__title">Review queue</h1>
      <p className="page__intro">These labels need a person to look at them. Open one to approve or reject it.</p>
      <ReviewQueueBrowser />
    </main>
  );
}
