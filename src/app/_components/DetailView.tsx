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
import { LABEL_BANNER_CLASS, labelVerdictText } from "./ResultsChecklist";

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
 * advisory boundary explicitly (TH-R20, this ticket's own acceptance
 * evidence: "Say plainly that it never changes the verdict").
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
  return `${headline} ${reasonSentence} This is an advisory signal. It never changes the verdict.`;
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
      <div className="detail-field__compare">
        <div className="detail-field__value">
          <span className="detail-field__value-label">{detectedColumnLabel(row.field)}</span>
          <span className="detail-field__value-text">{displayedLabelValue || "Not found on the label."}</span>
        </div>
        <div className="detail-field__value">
          <span className="detail-field__value-label">{expectedColumnLabel(row.field)}</span>
          <span className="detail-field__value-text">{row.applicationValue}</span>
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

      <div className="detail-view__layout">
        {/* PRD §5: "label image side-by-side with extracted vs application
            values per field". Width/height come from the persisted,
            EXIF-corrected pixel dimensions, so the browser reserves the
            right space before the image itself loads. A plain `<img>`, not
            `next/image`: this route already serves one fixed, pre-sized
            JPEG per request (`OUTPUT_MEDIA_TYPE`), so there is nothing for
            Next's optimizer to resize or reformat — routing this compliance
            photo through it would add a second internal HTTP hop for no
            real gain (eslint flags this as a Core Web Vitals warning, not
            an error; accepted deliberately). */}
        <img
          className="detail-view__image"
          src={detail.labelImage.url}
          width={detail.labelImage.width}
          height={detail.labelImage.height}
          // "The label submitted with this application", not "...photo" or
          // "...image": a screen reader already announces this element as
          // an image, so restating that in the alt text is redundant
          // (CodeRabbit finding, TRO-466 review round 1) — describe the
          // content, not the fact that it is a picture of it.
          alt="The label submitted with this application"
        />

        <ul className="detail-field-list">
          {detail.fields.map((row) => (
            <FieldRow key={row.field} row={row} boldSignal={detail.boldSignal} />
          ))}
        </ul>
      </div>
    </div>
  );
}
