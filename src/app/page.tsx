/**
 * The Verify screen (TRO-465, PRD §5, TH-R1, TH-R3). One obvious primary
 * flow, replacing the scaffold placeholder: upload a label photo, fill in
 * the application fields, press Verify, read the checklist.
 */
import { VerifyForm } from "./_components/VerifyForm";

export default function Home() {
  return (
    <main className="page">
      <h1 className="page__title">Verify a label</h1>
      <p className="page__intro">
        Add a label photo and the application details below. LabelHunter checks each field and flags anything that
        needs a closer look.
      </p>
      <VerifyForm />
    </main>
  );
}
