/**
 * Jenny's paper checklist, digitized (PRD §5, TH-R1, TH-R20): one row per
 * field, a ✓ / ✗ / ⚠ mark, the evidence the extractor read, and a one-line
 * reason — never a bare confidence percentage. Purely presentational: it
 * takes the API's response shape as a prop and renders it, so it is
 * testable with no network and no form state.
 */
import type { FieldVerdict, LabelVerdict } from "../../server/router";
import type { VerifySuccessResponse } from "../api/verify/types";

const VERDICT_ICON: Record<FieldVerdict, string> = {
  MATCH: "✓",
  MISMATCH: "✗",
  NEEDS_REVIEW: "⚠",
};

const VERDICT_STATUS_TEXT: Record<FieldVerdict, string> = {
  MATCH: "Match.",
  MISMATCH: "Does not match.",
  NEEDS_REVIEW: "Needs review.",
};

const VERDICT_ROW_CLASS: Record<FieldVerdict, string> = {
  MATCH: "checklist-row--match",
  MISMATCH: "checklist-row--mismatch",
  NEEDS_REVIEW: "checklist-row--needs_review",
};

const LABEL_BANNER_CLASS: Record<LabelVerdict, string> = {
  PASS: "label-verdict-banner--pass",
  FAIL: "label-verdict-banner--fail",
  REVIEW: "label-verdict-banner--review",
};

function labelVerdictText(result: VerifySuccessResponse): string {
  if (result.labelVerdict === "PASS") return "This label matches the application.";
  if (result.labelVerdict === "FAIL") return "This label does not match the application.";
  return result.headlineMessage ?? "This label needs review.";
}

export interface ResultsChecklistProps {
  result: VerifySuccessResponse;
}

export function ResultsChecklist({ result }: ResultsChecklistProps) {
  return (
    <div className="results" aria-live="polite">
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
                label. */}
            <span className="checklist-row__evidence">{row.evidence ? `On the label: “${row.evidence}”` : "Not found on the label."}</span>
            <span className="checklist-row__reason">{row.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
