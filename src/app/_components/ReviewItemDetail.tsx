/**
 * The review queue's review/detail view (TRO-476, PRD §5: "needs-human
 * items with reason"; TH-R22, the differentiator — see CHANGES.md).
 * Purely presentational: it takes the server-shaped item as a prop and
 * renders it, the same division `ResultsChecklist.tsx` uses.
 *
 * Does not show the label image — see `get-item.ts`'s file comment for
 * why (the image-serving route is a sibling ticket's still-open PR, and
 * PRD §5's review-queue line does not ask for one).
 *
 * CSS classes below are prefixed `review-field*`, not `detail-field*`:
 * `src/app/_components/DetailView.tsx` (LH-016/TRO-466, still an open PR)
 * defines its own `detail-field*` rules for a visually similar per-field
 * comparison. Reusing that exact name here, independently, risked either
 * a merge conflict or two silently-duplicate rules once that PR lands.
 * `checklist-row--*` below IS shared on purpose — those classes are
 * already merged (`ResultsChecklist.tsx`), so reusing them is the real
 * "match existing style" this ticket's brief asked for.
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
  );
}
