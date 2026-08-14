/**
 * The verification Detail view (TRO-466, PRD §5, TH-R3, TH-R20): the label
 * image side by side with every field's extracted-vs-application
 * comparison, match badges, a "Resolved by Sonnet" annotation, and the
 * government warning's own detected-vs-required framing. Purely
 * presentational — it takes the server-shaped detail as a prop and renders
 * it, so it is testable with no network and no database. Matches
 * `ResultsChecklist.tsx`'s own style, including reusing its verdict-banner
 * text and classes so the two views never say the same fact two different
 * ways.
 */
import type { FieldVerdict } from "../../server/router";
import type { VerificationBoldSignalDetail, VerificationDetail, VerificationFieldDetail } from "../../server/verification-detail";
import { CANONICAL_WARNING_TEXT } from "../../server/warning/canonical";
import { LabelImageFigure } from "./LabelImageFigure";
import { LABEL_BANNER_CLASS, labelVerdictText } from "./ResultsChecklist";
import { WarningTranscription } from "./WarningTranscription";

const VERDICT_ICON: Record<FieldVerdict, string> = {
  MATCH: "✓",
  MISMATCH: "✗",
  NEEDS_REVIEW: "⚠︎",
};

const VERDICT_STATUS_TEXT: Record<FieldVerdict, string> = {
  MATCH: "Match.",
  MISMATCH: "Does not match.",
  NEEDS_REVIEW: "Needs review.",
};

const VERDICT_FIELD_CLASS: Record<FieldVerdict, string> = {
  MATCH: "detail-field--match",
  MISMATCH: "detail-field--mismatch",
  NEEDS_REVIEW: "detail-field--needs_review",
};

/**
 * The government warning has no per-application value to compare against
 * (`VerificationFieldDetail.applicationValue`'s own doc comment) — its row
 * gets its own column labels instead of the generic "On the label" / "On
 * the application" pair every other field uses. This is a rendering
 * choice only: it never diffs the two strings itself, and the verdict
 * badge and `reason` text below still carry the actual judgment, computed
 * upstream (standing rule 11 — the warning diff shown must be the
 * exact-compare result, never a fuzzy re-derivation invented here).
 */
function detectedColumnLabel(field: VerificationFieldDetail["field"]): string {
  return field === "government_warning" ? "Detected on the label" : "On the label";
}

function expectedColumnLabel(field: VerificationFieldDetail["field"]): string {
  return field === "government_warning" ? "What TTB requires" : "On the application";
}

/**
 * Plain-language headline for LH-025's pixel-measured bold signal
 * (TRO-532/TRO-533), keyed by the three-valued `signal` — never a bare
 * confidence number (standing rule 12). Paired with `boldSignal.reason`
 * (ASD-STE100 prose already, `bold-detect.ts`'s own header comment) for
 * the supporting detail, and a fixed closing sentence that states the
 * advisory boundary explicitly (TH-R20). TRO-533's original acceptance
 * evidence read "say plainly that it never changes the verdict" — TRO-569
 * / INT-005 narrowed that: the closing sentence below now states the
 * boundary that actually survives (never a hard FAIL by itself) instead
 * of the wider, now-false claim.
 */
const BOLD_SIGNAL_HEADLINE: Record<VerificationBoldSignalDetail["signal"], string> = {
  bold: "LabelHunter's pixel measurement finds the prefix bold.",
  "not-bold": "LabelHunter's pixel measurement does not find the prefix bold.",
  uncertain: "LabelHunter could not measure whether the prefix is bold.",
};

function capitalizeSentence(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function boldSignalAdvisoryText(boldSignal: VerificationBoldSignalDetail): string {
  const headline = BOLD_SIGNAL_HEADLINE[boldSignal.signal];
  const reasonSentence = capitalizeSentence(boldSignal.reason);
  // TRO-569 / INT-005: this signal is still advisory — it never fails a
  // label by itself. It is no longer true that it "never changes the
  // verdict": a not-bold reading now sends an otherwise-matching label
  // for human review instead of a silent pass. State the rule, not the
  // old, wider claim.
  return `${headline} ${reasonSentence} This is an advisory signal. It never fails a label by itself. A not-bold reading sends an otherwise-matching label for human review instead of a silent pass.`;
}

function FieldRow({ row, boldSignal }: { row: VerificationFieldDetail; boldSignal: VerificationBoldSignalDetail | null }) {
  // The warning's own transcription is nulled by the router when its §4.4
  // override rejects it (bad confidence, evidence mismatch) even when real
  // text was detected — `evidence` stays populated in that case, so it is
  // the field that must render here, not `labelValue` (CodeRabbit finding,
  // TRO-466 review round 2).
  const displayedLabelValue = row.field === "government_warning" ? row.evidence : row.labelValue;
  return (
    <li className={`detail-field ${VERDICT_FIELD_CLASS[row.verdict]}`} data-testid={`detail-field-${row.field}`}>
      <div className="detail-field__header">
        <span className="detail-field__icon" aria-hidden="true">
          {VERDICT_ICON[row.verdict]}
        </span>
        <span className="visually-hidden">{VERDICT_STATUS_TEXT[row.verdict]}</span>
        <span className="detail-field__name">{row.fieldLabel}</span>
      </div>
      {/* TRO-582: the warning row's two columns show the real texts, not
          placeholders — the transcription with its deviating words marked
          (display alignment only; the verdict and reason still come from
          the comparator, standing rule 11), and the statute verbatim so
          the reviewer compares against the actual requirement instead of
          a citation they must know by heart. */}
      <div className="detail-field__compare">
        <div className="detail-field__value">
          <span className="detail-field__value-label">{detectedColumnLabel(row.field)}</span>
          <span className="detail-field__value-text">
            {row.field === "government_warning" && displayedLabelValue ? (
              <WarningTranscription transcription={displayedLabelValue} />
            ) : (
              displayedLabelValue || "Not found on the label."
            )}
          </span>
        </div>
        <div className="detail-field__value">
          <span className="detail-field__value-label">{expectedColumnLabel(row.field)}</span>
          <span className="detail-field__value-text">
            {row.field === "government_warning" ? CANONICAL_WARNING_TEXT : row.applicationValue}
          </span>
        </div>
      </div>
      <p className="detail-field__reason">{row.reason}</p>
      {/* LH-025/LH-026 (TRO-532/TRO-533), CP-2 §7.2/§7.3, TH-R9. Only on
          the government_warning row — this signal has nothing to say
          about any other field. `boldSignal` is `null` whenever no crop
          was ever measured (see `types.ts`'s own comment), so this line
          simply does not render then, rather than show a misleading
          "not measured" state as if it were a real finding. */}
      {row.field === "government_warning" && boldSignal && (
        <p className="detail-field__bold-signal" data-testid="bold-signal-advisory">
          {boldSignalAdvisoryText(boldSignal)}
        </p>
      )}
    </li>
  );
}

export interface DetailViewProps {
  detail: VerificationDetail;
}

export function DetailView({ detail }: DetailViewProps) {
  return (
    <div className="detail-view">
      <p className={`label-verdict-banner ${LABEL_BANNER_CLASS[detail.labelVerdict]}`} data-testid="label-verdict-banner">
        {labelVerdictText(detail)}
      </p>

      {detail.resolvedBySonnet && (
        <div className="resolved-by-sonnet">
          <p className="resolved-by-sonnet__badge">Resolved by Sonnet</p>
          {detail.resolverNote && <p data-testid="resolver-note">{detail.resolverNote}</p>}
        </div>
      )}

      {/* PRD §5: "label image side-by-side with extracted vs application
          values per field" — a real grid with a dedicated image box
          (TRO-582); LabelImageFigure carries the plain-img and persisted-
          dimensions rationale both surfaces share. */}
      <div className="detail-layout">
        <LabelImageFigure image={detail.labelImage} />

        <ul className="detail-field-list">
          {detail.fields.map((row) => (
            <FieldRow key={row.field} row={row} boldSignal={detail.boldSignal} />
          ))}
        </ul>
      </div>
    </div>
  );
}
