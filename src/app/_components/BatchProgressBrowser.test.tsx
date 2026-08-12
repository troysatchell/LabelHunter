// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchClientError } from "../_lib/batch-client";
import { BatchProgressBrowser } from "./BatchProgressBrowser";
import type { BatchProgressResponse } from "../api/batch/[batchJobId]/types";

function progress(overrides: Partial<BatchProgressResponse> = {}): BatchProgressResponse {
  return {
    batchJobId: 7,
    status: "RUNNING",
    totalCount: 2,
    processedCount: 1,
    autoVerifiedCount: 1,
    passCount: 1,
    failCount: 0,
    resolvedBySonnetCount: 0,
    needsHumanCount: 0,
    failedCount: 0,
    startedAt: "2026-08-12T00:00:00.000Z",
    completedAt: null,
    latency: null,
    rateLimitBackoff: { active: false, itemCount: 0 },
    results: [],
    ...overrides,
  };
}

// A tiny real interval — reliable and fast without fake-timer/promise
// interleaving fragility (lessons.md #8: await an observable event, no
// fixed sleeps — `waitFor` below polls a real assertion, it does not sleep
// a fixed duration).
const FAST_POLL_MS = 15;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BatchProgressBrowser", () => {
  it("shows a loading state, then the summary and results table once the fetch resolves", async () => {
    const fetchProgress = vi.fn(async () => progress());
    render(<BatchProgressBrowser batchJobId={7} fetchProgress={fetchProgress} pollIntervalMs={100_000} />);

    expect(screen.getByText(/Loading batch progress/)).toBeInTheDocument();
    await screen.findByTestId("batch-status-banner");
    expect(screen.getByText("Results")).toBeInTheDocument();
  });

  it("shows the designed error state when the FIRST load fails, with a working retry", async () => {
    const fetchProgress = vi.fn<(batchJobId: number) => Promise<BatchProgressResponse>>(async () => {
      throw new BatchClientError("NOT_FOUND", "LabelHunter could not find that batch.");
    });
    render(<BatchProgressBrowser batchJobId={999} fetchProgress={fetchProgress} pollIntervalMs={100_000} />);

    await screen.findByText("LabelHunter could not find that batch.");
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fetchProgress.mockImplementationOnce(async () => progress());
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("batch-status-banner");
  });

  it("polls again while the batch is still RUNNING, and shows the newer data", async () => {
    const fetchProgress = vi
      .fn<(batchJobId: number) => Promise<BatchProgressResponse>>()
      .mockResolvedValueOnce(progress({ processedCount: 1 }))
      .mockResolvedValue(progress({ processedCount: 2 }));

    render(<BatchProgressBrowser batchJobId={7} fetchProgress={fetchProgress} pollIntervalMs={FAST_POLL_MS} />);

    await screen.findByTestId("batch-status-banner");
    await waitFor(() => expect(fetchProgress).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() => expect(screen.getByTestId("batch-status-banner")).toHaveTextContent("2 of 2"));
  });

  it("never has two polls in flight at once — an interval tick is skipped while a poll is still pending (CodeRabbit finding, local review round 1)", async () => {
    let resolveHeldPoll!: (value: BatchProgressResponse) => void;
    const heldPoll = new Promise<BatchProgressResponse>((resolve) => {
      resolveHeldPoll = resolve;
    });

    const fetchProgress = vi
      .fn<(batchJobId: number) => Promise<BatchProgressResponse>>()
      .mockResolvedValueOnce(progress({ processedCount: 1 })) // initial mount load
      .mockReturnValueOnce(heldPoll) // first poll tick — held open deliberately
      .mockResolvedValue(progress({ processedCount: 3 })); // any poll after that

    render(<BatchProgressBrowser batchJobId={7} fetchProgress={fetchProgress} pollIntervalMs={FAST_POLL_MS} />);
    await screen.findByTestId("batch-status-banner");

    // Long enough for several interval ticks to have fired if nothing
    // guarded against overlap — with the guard, exactly one poll call
    // happens (the one still held open) no matter how many ticks pass.
    await new Promise((resolve) => setTimeout(resolve, FAST_POLL_MS * 8));
    expect(fetchProgress).toHaveBeenCalledTimes(2);

    resolveHeldPoll(progress({ processedCount: 2 }));
    await waitFor(() => expect(screen.getByTestId("batch-status-banner")).toHaveTextContent("2 of 2"));
  });

  it("stops polling once the batch reaches a terminal status (COMPLETED)", async () => {
    const fetchProgress = vi.fn(async () => progress({ status: "COMPLETED", processedCount: 2 }));
    render(<BatchProgressBrowser batchJobId={7} fetchProgress={fetchProgress} pollIntervalMs={FAST_POLL_MS} />);

    await screen.findByTestId("batch-status-banner");
    const callsAfterFirstLoad = fetchProgress.mock.calls.length;
    // Wait comfortably longer than several poll intervals would take, then
    // confirm the call count never grew — a real, observable absence, not
    // a fixed sleep standing in for an assertion.
    await new Promise((resolve) => setTimeout(resolve, FAST_POLL_MS * 8));
    expect(fetchProgress.mock.calls.length).toBe(callsAfterFirstLoad);
  });

  it("keeps showing the last known progress, with a small non-fatal note, when a LATER poll fails", async () => {
    const fetchProgress = vi
      .fn<(batchJobId: number) => Promise<BatchProgressResponse>>()
      .mockResolvedValueOnce(progress({ processedCount: 1 }))
      .mockRejectedValueOnce(new BatchClientError("SERVICE", "LabelHunter could not reach the server."));

    render(<BatchProgressBrowser batchJobId={7} fetchProgress={fetchProgress} pollIntervalMs={FAST_POLL_MS} />);

    await screen.findByTestId("batch-status-banner");
    await waitFor(() => expect(fetchProgress).toHaveBeenCalledTimes(2), { timeout: 2000 });

    // The screen still shows the LAST successful data, not an error page.
    expect(screen.getByTestId("batch-status-banner")).toHaveTextContent("1 of 2");
    expect(screen.getByTestId("batch-poll-error")).toHaveTextContent("LabelHunter could not reach the server.");
  });
});
