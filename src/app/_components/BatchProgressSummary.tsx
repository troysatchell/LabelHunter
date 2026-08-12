/**
 * The batch progress summary (LH-042 / TRO-475, PRD §3.5: "live summary —
 * processed / auto-verified / resolved-by-Sonnet / needs-human / avg + p95
 * latency"). Purely presentational — takes the polling endpoint's own
 * response as a prop and renders it, testable with no network and no
 * polling interval.
 *
 * Also carries two of this ticket's four designed batch-scoped error
 * states (TH-R20): a partial-failure notice (`failedCount > 0`) and a
 * rate-limit backoff notice (`rateLimitBackoff.active`) — LH-041's own
 * real backoff/cooldown state, surfaced here via the polling response, not
 * recomputed.
 *
 * `autoVerifiedCount` is shown with its own one-line caveat (CP-3 §7.1's
 * explicit instruction): it bundles PASS and FAIL together — "decided
 * without a closer look," never "passed."
 */
import { formatDuration } from "../../lib/utils/format";
import type { BatchJobStatus } from "../../lib/db/enums";
import type { BatchProgressResponse } from "../api/batch/[batchJobId]/types";

export interface BatchProgressSummaryProps {
  progress: BatchProgressResponse;
}

const STATUS_TEXT: Record<BatchJobStatus, string> = {
  PENDING: "Waiting to start.",
  RUNNING: "In progress.",
  COMPLETED: "Finished.",
  FAILED: "Could not start.",
};

function labelWord(count: number): string {
  return count === 1 ? "label" : "labels";
}

export function BatchProgressSummary({ progress }: BatchProgressSummaryProps) {
  const { status, totalCount, processedCount, autoVerifiedCount, passCount, failCount, resolvedBySonnetCount, needsHumanCount, failedCount, latency, rateLimitBackoff } = progress;

  return (
    <div className="batch-progress-summary">
      <p
        className={`status-banner batch-progress-summary__status batch-progress-summary__status--${status.toLowerCase()}`}
        role="status"
        data-testid="batch-status-banner"
      >
        {STATUS_TEXT[status]} {processedCount} of {totalCount} {labelWord(totalCount)} processed.
      </p>

      <dl className="batch-stat-grid">
        <div className="batch-stat" data-testid="batch-stat-processed">
          <dt>Processed</dt>
          <dd>
            {processedCount} / {totalCount}
          </dd>
        </div>

        <div className="batch-stat" data-testid="batch-stat-auto-verified">
          <dt>Auto-verified</dt>
          <dd>
            {autoVerifiedCount}
            <p className="batch-stat__note">
              {passCount} matched. {failCount} did not. Neither needed a closer look.
            </p>
          </dd>
        </div>

        <div className="batch-stat" data-testid="batch-stat-resolved-by-sonnet">
          <dt>Resolved by Sonnet</dt>
          <dd>{resolvedBySonnetCount}</dd>
        </div>

        <div className="batch-stat" data-testid="batch-stat-needs-human">
          <dt>Needs a person</dt>
          <dd>{needsHumanCount}</dd>
        </div>

        <div className="batch-stat" data-testid="batch-stat-avg-latency">
          <dt>Average time per label</dt>
          <dd>{latency ? formatDuration(latency.avgMs) : "Not measured yet"}</dd>
        </div>

        <div className="batch-stat" data-testid="batch-stat-p95-latency">
          <dt>p95 time per label</dt>
          <dd>
            {latency ? formatDuration(latency.p95Ms) : "Not measured yet"}
            <p className="batch-stat__note">19 of 20 labels finish this fast or faster.</p>
          </dd>
        </div>
      </dl>

      {failedCount > 0 && (
        <div className="batch-notice batch-notice--partial-failure" role="status" data-testid="batch-partial-failure-notice">
          <p>
            {failedCount} {labelWord(failedCount)} could not be processed automatically. See the Status column below for each one&rsquo;s
            reason.
          </p>
        </div>
      )}

      {rateLimitBackoff.active && (
        <div className="batch-notice batch-notice--backoff" role="status" data-testid="batch-backoff-notice">
          <p>
            LabelHunter is pausing before it tries {rateLimitBackoff.itemCount} {labelWord(rateLimitBackoff.itemCount)} again. This can
            happen when the verification service is busy. No action is needed. Processing resumes on its own.
          </p>
        </div>
      )}
    </div>
  );
}
