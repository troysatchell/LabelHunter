/**
 * The batch results table (LH-042 / TRO-475, PRD §5: "results table (Label
 * / Brand / ABV / Net / Warning / Status) → click-through to detail").
 * Purely presentational — takes the polling endpoint's own rows as a prop
 * and renders them, the same division `ReviewQueueList.tsx` uses, so it is
 * testable with no network and no polling.
 *
 * Brand/ABV/Net/Warning are per-field ✓ / ✗ / ⚠ marks — the batch-table
 * digitization of the same checklist Sarah's own quote names field by
 * field ("Brand name matches? Check. ABV is correct? Check. Government
 * warning is there? Check.", `audit/requirements/source-TH.md`), reusing
 * the exact icon/text vocabulary the single-label checklist already
 * established (`ResultsChecklist.tsx`'s `VERDICT_ICON`/`VERDICT_STATUS_TEXT`)
 * so the same fact reads the same way in both views. Status is the OVERALL
 * label outcome, a separate fact from the four field marks.
 */
import Link from "next/link";
import type { FieldVerdict } from "../../server/router";
import type { BatchResultRowWire } from "../api/batch/[batchJobId]/types";
import { VERDICT_ICON, VERDICT_STATUS_TEXT } from "./ResultsChecklist";

export interface BatchResultsTableProps {
  results: BatchResultRowWire[];
}

function FieldMark({ verdict }: { verdict: FieldVerdict | null }) {
  if (verdict === null) {
    return (
      <span className="batch-mark batch-mark--none">
        <span aria-hidden="true">—</span>
        <span className="visually-hidden">Not available yet.</span>
      </span>
    );
  }
  return (
    <span className={`batch-mark batch-mark--${verdict.toLowerCase()}`}>
      <span aria-hidden="true">{VERDICT_ICON[verdict]}</span>
      <span className="visually-hidden">{VERDICT_STATUS_TEXT[verdict]}</span>
    </span>
  );
}

export function BatchResultsTable({ results }: BatchResultsTableProps) {
  if (results.length === 0) {
    return (
      <p className="status-banner" role="status">
        No labels yet. They will appear here as LabelHunter works through the batch.
      </p>
    );
  }

  return (
    <div className="batch-results-table__scroll">
      <table className="batch-results-table">
        <caption className="visually-hidden">Batch results, one row per label</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Brand</th>
            <th scope="col">ABV</th>
            <th scope="col">Net</th>
            <th scope="col">Warning</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row) => (
            <tr key={row.key} className={`batch-results-table__row batch-results-table__row--${row.statusTone}`} data-testid={`batch-result-row-${row.key}`}>
              <th scope="row" className="batch-results-table__label">
                {row.label}
              </th>
              <td>
                <FieldMark verdict={row.brand} />
              </td>
              <td>
                <FieldMark verdict={row.abv} />
              </td>
              <td>
                <FieldMark verdict={row.net} />
              </td>
              <td>
                <FieldMark verdict={row.warning} />
              </td>
              <td className="batch-results-table__status">
                {row.verificationId !== null ? (
                  <Link href={`/verify/${row.verificationId}`} aria-label={`View detail for ${row.brandName} (${row.label})`}>
                    {row.statusText}
                  </Link>
                ) : (
                  <span>{row.statusText}</span>
                )}
                {row.statusDetail && <p className="batch-results-table__detail">{row.statusDetail}</p>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
