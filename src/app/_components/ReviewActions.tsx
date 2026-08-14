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
  | { status: "error"; message: string; retryable: boolean };

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
  // A CONFLICT means the server already recorded a decision on this item —
  // re-enabling the buttons would leave a dead action a retry can only ever
  // 409 against (TH-R3: "no hidden actions" applies to actions that can
  // never succeed too, not only ones that are invisible). Every other error
  // is retryable (CodeRabbit finding, PR #16 review round 2).
  const isDisabled = phase.status === "pending" || phase.status === "success" || (phase.status === "error" && !phase.retryable);

  async function act(disposition: ReviewDisposition) {
    setPhase({ status: "pending", disposition });
    // `result` is read outside the `try` so a failure in `onResolved` itself
    // (e.g. the caller's `router.push`) never gets reported as "could not
    // record this decision" — the decision was recorded; only the
    // afterward step failed (CodeRabbit finding, PR #16 review round 2).
    let result: RecordDispositionResponse;
    try {
      result = await submit(reviewQueueId, disposition);
    } catch (error) {
      // Every CONFLICT is terminal, whether or not the body carried a
      // specific conflictDisposition — the earlier check required
      // `error.conflictDisposition` too, so a 409 body missing that field
      // fell through to the generic, retryable branch below and re-enabled
      // the buttons for an action that could still only ever 409 again
      // (CodeRabbit finding, local review round 2).
      if (error instanceof ReviewQueueClientError && error.kind === "CONFLICT") {
        const message = error.conflictDisposition
          ? `Someone already ${DISPOSITION_VERB[error.conflictDisposition]} this item. Your decision was not recorded.`
          : "Someone already recorded a decision on this item. Your decision was not recorded.";
        setPhase({ status: "error", message, retryable: false });
        return;
      }
      const message = error instanceof ReviewQueueClientError ? error.message : "LabelHunter could not record this decision. Try again.";
      setPhase({ status: "error", message, retryable: true });
      return;
    }
    setPhase({ status: "success", disposition: result.disposition });
    try {
      // `onResolved`'s type says it returns `void`, but TypeScript allows a
      // caller to pass an async function there anyway (a `void`-returning
      // callback type accepts one that returns a value, including a
      // Promise). `await`ing a non-Promise value is a no-op, so this line
      // is safe either way — and it is required either way: a *synchronous*
      // throw was already caught by wrapping the call in try/catch, but an
      // *asynchronous* rejection needs an await in the same try/catch to be
      // caught at all (CodeRabbit finding, local review round 2 — the first
      // version of this fix only handled the synchronous case).
      await onResolved(result);
    } catch (error) {
      // The decision is already recorded — a failure in the caller's own
      // callback (e.g. a router.push navigation error) must not become an
      // unhandled rejection on the promise this function returns (the
      // click handler calls `act` with `void`, so nothing else observes
      // it) (CodeRabbit finding, local review round 2).
      console.error("onResolved threw after a successful review-queue decision", error);
    }
  }

  // In-flight labels, matching the "X-ing…" convention every other submit
  // button in this app already uses (VerifyForm's "Checking the label…",
  // BatchUploadForm's "Starting the batch…") — a click that only dims a
  // button gives a first-time user on a slow connection no way to tell
  // "it registered" from "it's broken".
  const approvePending = phase.status === "pending" && phase.disposition === "APPROVED";
  const rejectPending = phase.status === "pending" && phase.disposition === "REJECTED";

  /* The one persistent status line's text, derived straight from `phase`.
     Empty in the idle and error states — the error has its own
     role="alert" panel below. */
  const statusText =
    phase.status === "pending" ? "Recording…" : phase.status === "success" ? `Recorded: ${DISPOSITION_VERB[phase.disposition]}.` : "";

  return (
    <div className="review-actions">
      {/* aria-busy on the buttons group only, never on a wrapper that
          contains the role="status" line below: aria-busy lets assistive
          tech withhold changes inside the busy region until it clears
          (WAI-ARIA), which would silence "Recording…" — the one line that
          exists to announce the in-flight decision. */}
      <div className="review-actions__buttons" aria-busy={phase.status === "pending"}>
        <button type="button" className="primary-button" disabled={isDisabled} onClick={() => void act("APPROVED")}>
          {approvePending ? (
            <>
              <span className="busy-spinner" aria-hidden="true" />
              Recording…
            </>
          ) : (
            "Approve"
          )}
        </button>
        <button type="button" className="reject-button" disabled={isDisabled} onClick={() => void act("REJECTED")}>
          {rejectPending ? (
            <>
              <span className="busy-spinner" aria-hidden="true" />
              Recording…
            </>
          ) : (
            "Reject"
          )}
        </button>
      </div>

      {/* One persistent polite region, present from first render, not a
          new one mounted per phase — a live region only reliably announces
          content ADDED to it after it already exists in the DOM
          (WAI-ARIA; the same reasoning VerifyForm's results region
          documents). The element stays mounted through every phase; only
          its class swaps, so it is invisible while it has nothing to say. */}
      <p className={statusText === "" ? "visually-hidden" : "status-banner"} role="status">
        {phase.status === "pending" && <span className="busy-spinner" aria-hidden="true" />}
        {statusText}
      </p>

      {phase.status === "error" && (
        <div className="error-panel" role="alert">
          <p className="error-panel__title">Could not record this decision</p>
          <p className="error-panel__message">{phase.message}</p>
        </div>
      )}
    </div>
  );
}
