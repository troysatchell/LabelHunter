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
    const interval = setInterval(() => {
      const current = phaseRef.current;
      if (current.status !== "success" || isTerminal(current.progress.status)) return;
      fetchProgress(batchJobId).then(
        (progress) => setPhase({ status: "success", progress, pollErrorMessage: null }),
        (error: unknown) => {
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
      <p className="status-banner" role="status">
        Loading batch progress…
      </p>
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
      {phase.pollErrorMessage && (
        <p className="status-banner" role="status" data-testid="batch-poll-error">
          {phase.pollErrorMessage} LabelHunter will keep trying.
        </p>
      )}
      <h2 className="batch-results-heading">Results</h2>
      <BatchResultsTable results={phase.progress.results} />
    </>
  );
}
