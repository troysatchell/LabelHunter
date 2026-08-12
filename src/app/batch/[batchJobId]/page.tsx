/**
 * The batch progress + results page (LH-042 / TRO-475, PRD §3.5, §5,
 * TH-R4). A server component that validates the URL's own `batchJobId`
 * format — the same boundary check `verify/[verificationId]/page.tsx`
 * already established for an identical URL-id shape — then hands off to
 * `BatchProgressBrowser`, which polls the live progress client-side.
 *
 * A well-formed id that does not exist in the database is NOT a 404 here.
 * `BatchProgressBrowser`'s own designed error state (a 404 from the API,
 * `kind: "NOT_FOUND"`) handles that case with a retry affordance — a
 * better fit for a page someone may have bookmarked while the batch was
 * still running than a hard dead end. `notFound()` below is reserved for a
 * URL segment that could never be a real id at all.
 *
 * TRO-480: before this ticket, this page had no on-page way back at all.
 * The nav link sits at the TOP here, unlike the other four screens this
 * ticket adds one to (which match `src/app/page.tsx`'s bottom-of-page
 * convention) — PRD §5's own results table can run to "a few hundred
 * rows," so a link only below the table would make a reviewer scroll
 * through all of them first just to leave.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchProgressBrowser } from "../../_components/BatchProgressBrowser";

export default async function BatchProgressPage({ params }: { params: Promise<{ batchJobId: string }> }) {
  const { batchJobId: batchJobIdRaw } = await params;

  // Same boundary check as `verify/[verificationId]/page.tsx`: `Number()`
  // alone accepts hex, exponent notation, signs, and decimals, and a long
  // enough digit string can lose precision above `Number.MAX_SAFE_INTEGER`
  // — reject anything that is not already canonical decimal digits first.
  if (!/^\d+$/.test(batchJobIdRaw)) {
    notFound();
  }
  const batchJobId = Number(batchJobIdRaw);
  if (!Number.isSafeInteger(batchJobId) || batchJobId <= 0) {
    notFound();
  }

  return (
    <main className="page page--wide">
      <h1 className="page__title">Batch progress</h1>
      <p className="page__nav-links">
        <Link href="/batch" className="secondary-button">
          Start a batch
        </Link>
      </p>
      <BatchProgressBrowser batchJobId={batchJobId} />
    </main>
  );
}
