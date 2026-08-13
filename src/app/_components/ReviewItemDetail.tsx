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
 * drive-by here. `checklist-row--*` below IS shared on purpose — those
 * classes are already merged (`ResultsChecklist.tsx`), so reusing them is
 * the real "match existing style" this ticket's brief asked for.
 */
import type { FieldVerdict, ReviewDisposition } from "../../lib/db/enums";
import type { ReviewQueueItemDetail } from "../../server/review-queue";
import { formatTimestampUTC } from "../_lib/format-timestamp";

const VERDICT_ICON: Record<FieldVerdict, string> = {
  MATCH: "✓",
  MISMATCH: "✗",
  NEEDS_REVIEW: "⚠",
};

const VERDICT_ROW_CLASS: Record<FieldVerdict, string> = {
  MATCH: "checklist-row--match",
  MISMATCH: "checklist-row--mismatch",
  NEEDS_REVIEW: "checklist-row--needs_review",
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
        {item.brandName} — {item.classType} ({item.beverageType})
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

      <div className="review-item__layout">
        {/* The artwork is the object the reviewer is ruling on (TH-R1:
            "looks at the label artwork, and checks") — side by side with
            the field comparison, the arrangement DetailView.tsx already
            uses (see its comment at the img for the plain-`<img>` and
            persisted width/height decisions, which carry over verbatim). */}
        <img
          className="review-item__image"
          src={item.labelImage.url}
          width={item.labelImage.width}
          height={item.labelImage.height}
          alt="The label submitted with this application"
        />

        <ul className="review-field-list">
          {item.fields.map((row) => (
            <li key={row.field} className={`review-field ${VERDICT_ROW_CLASS[row.verdict]}`} data-testid={`review-field-${row.field}`}>
              <div className="review-field__header">
                <span className="review-field__icon" aria-hidden="true">
                  {VERDICT_ICON[row.verdict]}
                </span>
                <span className="review-field__name">{row.fieldLabel}</span>
              </div>
              <div className="review-field__compare">
                <div className="review-field__value">
                  <span className="review-field__value-label">On the label</span>
                  <span className="review-field__value-text">{row.evidence ? row.evidence : "Not found on the label."}</span>
                </div>
                <div className="review-field__value">
                  <span className="review-field__value-label">On the application</span>
                  <span className="review-field__value-text">{row.applicationValue}</span>
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
