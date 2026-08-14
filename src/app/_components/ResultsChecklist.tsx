/**
 * Jenny's paper checklist, digitized (PRD §5, TH-R1, TH-R20): one row per
 * field, a ✓ / ✗ / ⚠ mark, the evidence the extractor read, and a one-line
 * reason — never a bare confidence percentage. Purely presentational: it
 * takes the API's response shape as a prop and renders it, so it is
 * testable with no network and no form state.
 */
import Link from "next/link";
import type { FieldVerdict, LabelVerdict } from "../../server/router";
import type { VerifySuccessResponse } from "../api/verify/types";
import { WarningTranscription } from "./WarningTranscription";

// Exported (LH-042 / TRO-475) so the batch results table
// (`BatchResultsTable.tsx`) shows the identical icon and status word for
// the identical per-field verdict — the same product fact, in two views,
// must read the same way (the same reasoning `LABEL_BANNER_CLASS` and
// `labelVerdictText` below already state for the label-level verdict).
export const VERDICT_ICON: Record<FieldVerdict, string> = {
  MATCH: "✓",
  MISMATCH: "✗",
  NEEDS_REVIEW: "⚠︎",
};

export const VERDICT_STATUS_TEXT: Record<FieldVerdict, string> = {
  MATCH: "Match.",
  MISMATCH: "Does not match.",
  NEEDS_REVIEW: "Needs review.",
};

const VERDICT_ROW_CLASS: Record<FieldVerdict, string> = {
  MATCH: "checklist-row--match",
  MISMATCH: "checklist-row--mismatch",
  NEEDS_REVIEW: "checklist-row--needs_review",
};

export const LABEL_BANNER_CLASS: Record<LabelVerdict, string> = {
  PASS: "label-verdict-banner--pass",
  FAIL: "label-verdict-banner--fail",
  REVIEW: "label-verdict-banner--review",
};

/** The label-verdict banner's own text. Exported (TRO-466) so the Detail
 * view (`DetailView.tsx`) shows the identical wording for the identical
 * verdict — the same product fact, in two views, must read the same way.
 * `LabelVerdictSummary` is a minimal structural type, not the full
 * `VerifySuccessResponse` — `VerifySuccessResponse` still satisfies it, and
 * so does `VerificationDetail` (`src/server/verification-detail/types.ts`)
 * once it carries its own `headlineMessage`. */
export interface LabelVerdictSummary {
  labelVerdict: LabelVerdict;
  headlineMessage: string | null;
}

export function labelVerdictText(result: LabelVerdictSummary): string {
  if (result.labelVerdict === "PASS") return "This label matches the application.";
  if (result.labelVerdict === "FAIL") return "This label does not match the application.";
  return result.headlineMessage ?? "This label needs review.";
}

export interface ResultsChecklistProps {
  result: VerifySuccessResponse;
}

/**
 * `aria-live` is deliberately NOT set on this component's own wrapper.
 * A live region only reliably announces content it receives AFTER it is
 * already in the DOM; a region that mounts with its content already
 * inside it (exactly how this component appears — swapped in whole once
 * `phase.status === "success"`) is not guaranteed to be announced. The
 * caller (`VerifyForm.tsx`) owns one persistent `aria-live="polite"`
 * region, present from the form's first render, and mounts this
 * component inside it — see that file's comment.
 */
export function ResultsChecklist({ result }: ResultsChecklistProps) {
  return (
    <div className="results">
      <p className={`label-verdict-banner ${LABEL_BANNER_CLASS[result.labelVerdict]}`} data-testid="label-verdict-banner">
        {labelVerdictText(result)}
      </p>
      <ul className="checklist">
        {result.fields.map((row) => (
          <li key={row.field} className={`checklist-row ${VERDICT_ROW_CLASS[row.verdict]}`} data-testid={`checklist-row-${row.field}`}>
            <span className="checklist-row__icon" aria-hidden="true">
              {VERDICT_ICON[row.verdict]}
            </span>
            <span className="visually-hidden">{VERDICT_STATUS_TEXT[row.verdict]}</span>
            <span className="checklist-row__field">{row.fieldLabel}</span>
            {/* PRD §5: "per-field rows with evidence and reason" — the
                verbatim label text the extractor copied, not the cleaned
                `labelValue`, so a reviewer sees exactly what was on the
                label. The warning row's deviating words are marked
                (TRO-582) — display alignment only; the verdict and
                reason still come from the comparator. */}
            <span className="checklist-row__evidence">
              {row.evidence ? (
                row.field === "government_warning" ? (
                  <>
                    On the label: &ldquo;
                    <WarningTranscription transcription={row.evidence} />
                    &rdquo;
                  </>
                ) : (
                  `On the label: “${row.evidence}”`
                )
              ) : (
                "Not found on the label."
              )}
            </span>
            <span className="checklist-row__reason">{row.reason}</span>
          </li>
        ))}
      </ul>
      {/* TRO-466, PRD §5's Detail view: one clearly labeled link, styled
          like a button (TH-R3 — large controls, no hunting), to the label
          photo and the full side-by-side comparison. */}
      <Link href={`/verify/${result.verificationId}`} className="secondary-button">
        See the label photo and full comparison
      </Link>
    </div>
  );
}
