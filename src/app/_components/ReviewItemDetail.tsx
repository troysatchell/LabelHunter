/**
 * The review queue's review/detail view (TRO-476, PRD §5: "needs-human
 * items with reason"; TH-R22, the differentiator — see CHANGES.md).
 * Purely presentational: it takes the server-shaped item as a prop and
 * renders it, the same division `ResultsChecklist.tsx` uses.
 *
 * Shows the label image beside the per-field comparison (TRO-575) — the
 * same side-by-side arrangement `DetailView.tsx` uses, so both screens
 * teach one layout: artwork on one side, field verdicts on the other.
 * The image was originally omitted because the byte-serving route was a
 * sibling ticket's then-unmerged work; see `get-item.ts`'s file comment.
 *
 * CSS classes below are prefixed `review-field*`, not `detail-field*`:
 * `src/app/_components/DetailView.tsx` (LH-016/TRO-466, merged since)
 * defines its own `detail-field*` rules for a visually similar per-field
 * comparison; consolidating the two families is TRO-578's job, not a
 * drive-by here. `VERDICT_ROW_CLASS` below maps to `review-field--match`
 * etc., not `checklist-row--*`: an earlier version of this file applied
 * the `checklist-row--*` verdict classes to a `review-field` element, but
 * `.review-field`'s own border-left shorthand (added later in
 * globals.css) won the cascade at equal specificity and silently reset
 * every verdict color back to neutral gray. `review-field--*` is scoped
 * to this file's own element and does not have that conflict.
 */
import type { FieldVerdict, ReviewDisposition } from "../../lib/db/enums";
import type { ReviewQueueItemDetail } from "../../server/review-queue";
import { CANONICAL_WARNING_TEXT } from "../../server/warning/canonical";
import { formatTimestampUTC } from "../_lib/format-timestamp";
import { LabelImageFigure } from "./LabelImageFigure";
import { WarningTranscription } from "./WarningTranscription";

const VERDICT_ICON: Record<FieldVerdict, string> = {
  MATCH: "✓",
  MISMATCH: "✗",
  NEEDS_REVIEW: "⚠",
};

/** Spoken verdict for screen readers — the icon above is aria-hidden and
 * the row's state is otherwise only a border color. Same words as
 * `DetailView.tsx`'s own `VERDICT_STATUS_TEXT` (one meaning, one
 * phrasing, both screens). */
const VERDICT_STATUS_TEXT: Record<FieldVerdict, string> = {
  MATCH: "Match.",
  MISMATCH: "Does not match.",
  NEEDS_REVIEW: "Needs review.",
};

const VERDICT_ROW_CLASS: Record<FieldVerdict, string> = {
  MATCH: "review-field--match",
  MISMATCH: "review-field--mismatch",
  NEEDS_REVIEW: "review-field--needs_review",
};

const DISPOSITION_VERB: Record<ReviewDisposition, string> = {
  APPROVED: "approved",
  REJECTED: "rejected",
};

export interface ReviewItemDetailProps {
  item: ReviewQueueItemDetail;
}

export function ReviewItemDetail({ item }: ReviewItemDetailProps) {
  return (
    <div className="review-item-detail" data-testid="review-item-detail">
      <p className="review-item__reason" data-testid="review-item-reason">
        {item.reasonText}
      </p>

      <p className="review-item__context">
        {item.brandName} · {item.classType} ({item.beverageType})
      </p>
      <p className="review-item__waiting">In the queue since {formatTimestampUTC(item.createdAt)}</p>

      {item.disposition && item.disposedAt && (
        <p className="status-banner" data-testid="review-item-disposition">
          This item was already {DISPOSITION_VERB[item.disposition]}, on {formatTimestampUTC(item.disposedAt)}.
        </p>
      )}

      {(item.resolverNote || item.resolverFields) && (
        <div className="resolver-suggestion" data-testid="resolver-suggestion">
          <p className="resolver-suggestion__badge">Sonnet&rsquo;s suggestion</p>
          {item.resolverNote && <p data-testid="resolver-note">{item.resolverNote}</p>}
          {item.resolverFields?.map((field, index) => (
            <div key={`${field.field}-${index}`} className="resolver-suggestion__field">
              <p className="resolver-suggestion__field-name">{field.field.replace(/_/g, " ")}</p>
              {field.correctedValue && <p>Sonnet read: {field.correctedValue}</p>}
              <p>{field.reason}</p>
            </div>
          ))}
        </div>
      )}

      {/* The artwork is the object the reviewer is ruling on (TH-R1:
          "looks at the label artwork, and checks") — a real grid with a
          dedicated, sticky image box (TRO-582), shared with DetailView. */}
      <div className="detail-layout">
        <LabelImageFigure image={item.labelImage} />

        <ul className="review-field-list">
          {item.fields.map((row) => (
            <li key={row.field} className={`review-field ${VERDICT_ROW_CLASS[row.verdict]}`} data-testid={`review-field-${row.field}`}>
              <div className="review-field__header">
                <span className="review-field__icon" aria-hidden="true">
                  {VERDICT_ICON[row.verdict]}
                </span>
                <span className="visually-hidden">{VERDICT_STATUS_TEXT[row.verdict]}</span>
                <span className="review-field__name">{row.fieldLabel}</span>
              </div>
              {/* TRO-582: the warning row shows the real texts — its
                  transcription with deviating words marked (display
                  alignment only; the verdict and reason still come from
                  the comparator) against the statute verbatim, under the
                  same column wording DetailView uses. Every other field
                  keeps the generic label/application pair. The old
                  application-side placeholder ("the statutory warning
                  text (27 CFR part 16)") read as missing data. */}
              <div className="review-field__compare">
                <div className="review-field__value">
                  <span className="review-field__value-label">
                    {row.field === "GOVERNMENT_WARNING" ? "Detected on the label" : "On the label"}
                  </span>
                  <span className="review-field__value-text">
                    {row.field === "GOVERNMENT_WARNING" && row.evidence ? (
                      <WarningTranscription transcription={row.evidence} />
                    ) : (
                      row.evidence || "Not found on the label."
                    )}
                  </span>
                </div>
                <div className="review-field__value">
                  <span className="review-field__value-label">
                    {row.field === "GOVERNMENT_WARNING" ? "What TTB requires" : "On the application"}
                  </span>
                  <span className="review-field__value-text">
                    {row.field === "GOVERNMENT_WARNING" ? CANONICAL_WARNING_TEXT : row.applicationValue}
                  </span>
                </div>
              </div>
              <p className="review-field__reason">{row.reason}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
