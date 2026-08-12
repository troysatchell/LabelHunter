/**
 * The Detail view's page (TRO-466, PRD §5, TH-R3, TH-R20): a server
 * component, reached from the checklist's own "See the label photo and
 * full comparison" link (`ResultsChecklist.tsx`) or a direct URL. It reads
 * the verification straight from the database — no client fetch, no
 * loading state.
 *
 * A bad id or an unknown verification calls Next's own `notFound()`
 * (`next/navigation`), which renders this route segment's `not-found.tsx`
 * and answers with a real 404 status — not a 200 response that merely
 * says "not found" in its body text (CodeRabbit finding, TRO-466 review
 * round 1: the first version of this file rendered an inline component
 * instead, which this repo's own designed-error-state bar, TH-R20, reads
 * as an honest status code, not only honest words).
 *
 * Kept intentionally thin: every branch is one line, and the real logic
 * (`getVerificationDetail`, `DetailView`) is tested on its own, the same
 * division `src/app/page.tsx` (untested, equally thin) already uses for
 * the verify form.
 *
 * TRO-480: before this ticket, arriving here left no on-page way back —
 * only this route's own `not-found.tsx` had one. The bottom nav link below
 * matches `src/app/page.tsx`'s own `.page__nav-links` pattern (TH-R3: a
 * screen this deep in the app still needs one obvious way out).
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "../../../lib/db";
import { getVerificationDetail } from "../../../server/verification-detail";
import { DetailView } from "../../_components/DetailView";

export default async function VerificationDetailPage({
  params,
}: {
  params: Promise<{ verificationId: string }>;
}) {
  const { verificationId: verificationIdRaw } = await params;

  // `Number()` alone accepts hex ("0x5"), exponent notation ("1e2"), signs,
  // and decimals, and `Number.isInteger` does not catch precision loss
  // above `Number.MAX_SAFE_INTEGER` — a long enough digit string can round
  // to a different, smaller integer and silently query the wrong row
  // (CodeRabbit finding, TRO-466 review round 2). Reject anything that is
  // not already canonical decimal digits before converting.
  if (!/^\d+$/.test(verificationIdRaw)) {
    notFound();
  }

  const verificationId = Number(verificationIdRaw);
  if (!Number.isSafeInteger(verificationId) || verificationId <= 0) {
    notFound();
  }

  const result = await getVerificationDetail(db, verificationId);
  if (!result.found) {
    notFound();
  }

  return (
    <main className="page">
      <h1 className="page__title">Label detail</h1>
      <DetailView detail={result.detail} />
      <p className="page__nav-links">
        <Link href="/" className="secondary-button">
          Verify a label
        </Link>
      </p>
    </main>
  );
}
