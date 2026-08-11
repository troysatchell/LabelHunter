/**
 * Renders when `page.tsx` calls `notFound()` for this route segment
 * (TRO-466, TH-R20 — a designed error state, not a generic framework
 * page): a bad id, or a verification id that does not exist. Plain,
 * honest wording, with the one obvious way back (TH-R3).
 */
import Link from "next/link";

export default function VerificationNotFound() {
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
