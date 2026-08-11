/**
 * The Detail view's page (TRO-466, PRD §5, TH-R3, TH-R20): a server
 * component, reached from the checklist's own "See the label photo and
 * full comparison" link (`ResultsChecklist.tsx`) or a direct URL. It reads
 * the verification straight from the database — no client fetch, no
 * loading state — and either renders `DetailView` or a plain, honest
 * "not found" message. Kept intentionally thin: every branch it renders is
 * one line, and the real logic (`getVerificationDetail`, `DetailView`) is
 * tested on its own, the same division `src/app/page.tsx` (untested,
 * equally thin) already uses for the verify form.
 */
import Link from "next/link";
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
    return <NotFound />;
  }

  const result = await getVerificationDetail(db, verificationId);
  if (!result.found) {
    return <NotFound />;
  }

  return (
    <main className="page">
      <h1 className="page__title">Label detail</h1>
      <DetailView detail={result.detail} />
    </main>
  );
}

function NotFound() {
  return (
    <main className="page">
      <h1 className="page__title">Label detail</h1>
      <p className="status-banner">
        LabelHunter could not find a verification with that ID. It may have been removed, or the link may be wrong.
      </p>
      <p>
        <Link href="/" className="secondary-button">
          Verify a label
        </Link>
      </p>
    </main>
  );
}
