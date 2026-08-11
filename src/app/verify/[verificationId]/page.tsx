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
 */
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
  const verificationId = Number(verificationIdRaw);

  if (!Number.isInteger(verificationId) || verificationId <= 0) {
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
    </main>
  );
}
