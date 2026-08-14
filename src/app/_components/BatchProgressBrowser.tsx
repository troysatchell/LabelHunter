"use client";

/**
 * The batch progress page's data-fetching wrapper (LH-042 / TRO-475, PRD
 * §3.5: "polling endpoint driving a live summary"). Fetches
 * `GET /api/batch/:batchJobId` on mount, then again every `pollIntervalMs`
 * while the batch is still `PENDING`/`RUNNING` — the same `Phase`
 * state-machine pattern `ReviewQueueBrowser.tsx`/`VerifyForm.tsx` use for
 * their own requests, extended with a recurring poll.
 *
 * A poll failure AFTER the first successful load never wipes the screen —
 * the last known progress stays visible, with a small non-fatal note, and
 * polling keeps trying on its own next interval (TH-R20: uncertain beats a
 * jarring reset). Only a failure on the FIRST load shows the full designed
 * error state with a manual "Try again".
 */
import { useEffect, useRef, useState } from "react";
import { BatchClientError, fetchBatchProgress } from "../_lib/batch-client";
import type { BatchProgressResponse } from "../api/batch/[batchJobId]/types";
import { BatchProgressSummary } from "./BatchProgressSummary";
import { BatchResultsTable } from "./BatchResultsTable";

type Phase =
  | { status: "loading" }
  | { status: "success"; progress: BatchProgressResponse; pollErrorMessage: string | null }
  | { status: "error"; message: string };

const DEFAULT_POLL_INTERVAL_MS = 3000;

function isTerminal(status: BatchProgressResponse["status"]): boolean {
  return status === "COMPLETED" || status === "FAILED";
}

/** True when two poll payloads carry identical data (TRO-577). The poll
 * used to call `setPhase` with a fresh object every tick, so a batch
 * sitting still re-rendered the whole summary + results table every
 * `pollIntervalMs` — felt as a scroll hitch every few seconds on a long
 * results table. The payload is plain JSON from the API with arrays in a
 * stable server-side order, so string equality is an exact, cheap
 * comparison here. Exported for its own unit tests. */
export function isSameProgress(a: BatchProgressResponse, b: BatchProgressResponse): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface BatchProgressBrowserProps {
  batchJobId: number;
  /** Injected in tests; defaults to the real network call. */
  fetchProgress?: (batchJobId: number) => Promise<BatchProgressResponse>;
  /** Injected in tests to control poll cadence without waiting on real
   * timers. */
  pollIntervalMs?: number;
}

export function BatchProgressBrowser({ batchJobId, fetchProgress = fetchBatchProgress, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }: BatchProgressBrowserProps) {
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [requestId, setRequestId] = useState(0);
  // Read inside the interval callback below so ONE interval, set up once
  // per (batchJobId, fetchProgress, pollIntervalMs), always acts on the
  // LATEST phase — avoiding a stale closure without tearing down and
  // recreating the interval on every progress update. Written from an
  // effect, not directly in the render body — React's own `react-hooks/refs`
  // lint rule flags a ref write during render (render must stay a pure
  // read), and this effect still commits well before the next `setInterval`
  // tick, which is asynchronous by construction.
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    let cancelled = false;
    fetchProgress(batchJobId).then(
      (progress) => {
        if (!cancelled) setPhase({ status: "success", progress, pollErrorMessage: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof BatchClientError ? error.message : "LabelHunter could not load this batch. Try again.";
        setPhase({ status: "error", message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [batchJobId, requestId, fetchProgress]);

  useEffect(() => {
    // Two race conditions a naive "fire a fetch every tick" loop invites
    // (CodeRabbit finding, local review round 1), both closed here:
    //
    // 1. Overlapping requests. If one poll takes longer than
    //    `pollIntervalMs` to resolve — a slow network, a slow query on a
    //    large batch — the next tick would fire a SECOND request before the
    //    first one returns. `requestInFlight` skips a tick while one is
    //    still outstanding, so at most one poll is ever in flight.
    // 2. Out-of-order responses. Even with (1) closed, a browser can still
    //    deliver two responses out of the order their requests were sent
    //    (a retry, a proxy, real network jitter). `sequence`/`latestApplied`
    //    is a monotonic counter — a response older than the newest one
    //    already applied is discarded rather than overwriting fresher data
    //    with stale data.
    let requestInFlight = false;
    let sequence = 0;
    let latestApplied = 0;

    const interval = setInterval(() => {
      const current = phaseRef.current;
      if (current.status !== "success") return;
      if (isTerminal(current.progress.status)) {
        clearInterval(interval);
        return;
      }
      if (requestInFlight) return;

      requestInFlight = true;
      const thisSequence = ++sequence;
      fetchProgress(batchJobId).then(
        (progress) => {
          requestInFlight = false;
          if (thisSequence < latestApplied) return;
          latestApplied = thisSequence;
          // Skip the update when nothing changed AND there is no stale
          // poll-error banner to clear — a still batch then re-renders
          // nothing (TRO-577). When a previous tick errored, the update
          // must still run even on identical data, because clearing
          // pollErrorMessage is itself a visible change.
          const current = phaseRef.current;
          if (current.status === "success" && current.pollErrorMessage === null && isSameProgress(current.progress, progress)) {
            return;
          }
          setPhase({ status: "success", progress, pollErrorMessage: null });
        },
        (error: unknown) => {
          requestInFlight = false;
          if (thisSequence < latestApplied) return;
          latestApplied = thisSequence;
          const message = error instanceof BatchClientError ? error.message : "LabelHunter could not refresh this batch just now.";
          setPhase((p) => (p.status === "success" ? { ...p, pollErrorMessage: message } : p));
        },
      );
    }, pollIntervalMs);
    return () => clearInterval(interval);
  }, [batchJobId, fetchProgress, pollIntervalMs]);

  function retry() {
    setPhase({ status: "loading" });
    setRequestId((id) => id + 1);
  }

  if (phase.status === "loading") {
    return (
      <>
        {/* The status line stays OUTSIDE the aria-busy region: aria-busy
            lets assistive tech withhold changes inside the busy region
            until it clears (WAI-ARIA), and this line is the one
            announcement the first load makes. */}
        <p className="status-banner" role="status">
          <span className="busy-spinner" aria-hidden="true" />
          Loading batch progress…
        </p>
        {/* Placeholder tiles in the REAL stat grid reserve the summary's
            space, so the loaded numbers land without a large layout jump.
            aria-hidden: the status line above is the announcement. */}
        <div className="batch-progress-summary" aria-busy="true" aria-hidden="true">
          <div className="skeleton-block skeleton-block--banner" />
          <div className="batch-stat-grid">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="batch-stat skeleton-stat" />
            ))}
          </div>
        </div>
      </>
    );
  }

  if (phase.status === "error") {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel__title">Could not load this batch</p>
        <p className="error-panel__message">{phase.message}</p>
        <button type="button" className="secondary-button" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <>
      <BatchProgressSummary progress={phase.progress} />
      {/* The poll-error banner's PERSISTENT slot: the live region exists
          from the first successful load (content added to it later is
          what announces reliably — WAI-ARIA, the same reasoning
          VerifyForm's results region documents), and the reserved height
          keeps the banner's appearing and clearing from shifting the
          results table below. */}
      <div className="poll-error-slot" aria-live="polite">
        {phase.pollErrorMessage && (
          <p className="status-banner" data-testid="batch-poll-error">
            {phase.pollErrorMessage} LabelHunter will keep trying.
          </p>
        )}
      </div>
      <h2 className="batch-results-heading">Results</h2>
      <BatchResultsTable results={phase.progress.results} />
    </>
  );
}
