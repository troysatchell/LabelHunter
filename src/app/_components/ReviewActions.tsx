"use client";

/**
 * The review queue's approve/reject action (TRO-476, PRD §5: "approve/
 * reject records disposition"; TH-R3: large obvious buttons, no hidden
 * actions). Two buttons, nothing else — no menu, no confirmation dialog to
 * hunt through. Disabled together while a decision is in flight, so a
 * second click cannot fire a second request for the same item.
 */
import { useState } from "react";
import { ReviewQueueClientError, submitDisposition } from "../_lib/review-queue-client";
import type { ReviewDisposition } from "../../lib/db/enums";
import type { RecordDispositionResponse } from "../api/review-queue/types";

type Phase =
  | { status: "idle" }
  | { status: "pending"; disposition: ReviewDisposition }
  | { status: "success"; disposition: ReviewDisposition }
  | { status: "error"; message: string };

const DISPOSITION_VERB: Record<ReviewDisposition, string> = {
  APPROVED: "approved",
  REJECTED: "rejected",
};

export interface ReviewActionsProps {
  reviewQueueId: number;
  /** Injected in tests; defaults to the real network call. */
  submit?: (reviewQueueId: number, disposition: ReviewDisposition) => Promise<RecordDispositionResponse>;
  /** Called once a decision is successfully recorded — the caller (the
   * review page) decides what happens next (TRO-476 does not invent that;
   * see this ticket's report). */
  onResolved: (result: RecordDispositionResponse) => void;
}

export function ReviewActions({ reviewQueueId, submit = submitDisposition, onResolved }: ReviewActionsProps) {
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const isPending = phase.status === "pending";

  async function act(disposition: ReviewDisposition) {
    setPhase({ status: "pending", disposition });
    try {
      const result = await submit(reviewQueueId, disposition);
      setPhase({ status: "success", disposition: result.disposition });
      onResolved(result);
    } catch (error) {
      if (error instanceof ReviewQueueClientError && error.kind === "CONFLICT" && error.conflictDisposition) {
        setPhase({
          status: "error",
          message: `Someone already ${DISPOSITION_VERB[error.conflictDisposition]} this item. Your decision was not recorded.`,
        });
        return;
      }
      const message = error instanceof ReviewQueueClientError ? error.message : "LabelHunter could not record this decision. Try again.";
      setPhase({ status: "error", message });
    }
  }

  return (
    <div className="review-actions">
      <div className="review-actions__buttons">
        <button type="button" className="primary-button" disabled={isPending} onClick={() => void act("APPROVED")}>
          Approve
        </button>
        <button type="button" className="reject-button" disabled={isPending} onClick={() => void act("REJECTED")}>
          Reject
        </button>
      </div>

      {phase.status === "success" && <p className="status-banner">Recorded: {DISPOSITION_VERB[phase.disposition]}.</p>}

      {phase.status === "error" && (
        <div className="error-panel" role="alert">
          <p className="error-panel__title">Could not record this decision</p>
          <p className="error-panel__message">{phase.message}</p>
        </div>
      )}
    </div>
  );
}
