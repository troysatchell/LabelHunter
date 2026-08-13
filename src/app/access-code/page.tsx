/**
 * The access-code entry screen (TRO-482 / LH-061, PRD §8). `src/proxy.ts`
 * sends every unauthenticated page request here, carrying `?next=` so a
 * correct submission returns the visitor to where they were headed. This
 * file is a thin shell — all interactive logic lives in
 * `AccessCodeForm`/`AccessCodeFormView` (`../_components/AccessCodeForm.tsx`).
 */
import { AccessCodeForm } from "../_components/AccessCodeForm";

export default function AccessCodePage() {
  return (
    <main className="page">
      <h1 className="page__title">Enter your access code</h1>
      <p className="page__intro">LabelHunter is a shared prototype. Enter the access code from your invitation to continue.</p>
      <AccessCodeForm />
    </main>
  );
}
