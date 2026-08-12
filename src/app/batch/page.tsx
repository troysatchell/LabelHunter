/**
 * The batch upload screen (LH-042 / TRO-475, PRD §5: "manifest upload →
 * pairing preview → run"). Kept intentionally thin — the real logic lives
 * in `BatchUploadWorkspace`/`BatchUploadForm`, tested on their own — the
 * same division `src/app/page.tsx` already uses for the single-label form.
 *
 * TRO-480: before this ticket, this page had no on-page way back to `/` —
 * only the reverse link (verify screen -> "Start a batch") existed. The
 * bottom nav link matches `src/app/page.tsx`'s own `.page__nav-links`
 * pattern (TH-R3).
 */
import Link from "next/link";
import { BatchUploadWorkspace } from "../_components/BatchUploadWorkspace";

export default function BatchUploadPage() {
  return (
    <main className="page">
      <h1 className="page__title">Start a batch</h1>
      <p className="page__intro">
        Add a CSV manifest and your label images. LabelHunter checks the pairing first. You choose when to start.
      </p>
      <BatchUploadWorkspace />
      <p className="page__nav-links">
        <Link href="/" className="secondary-button">
          Verify a label
        </Link>
      </p>
    </main>
  );
}
