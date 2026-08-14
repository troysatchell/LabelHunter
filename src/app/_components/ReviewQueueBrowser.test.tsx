// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueueBrowser } from "./ReviewQueueBrowser";
import { ReviewQueueClientError } from "../_lib/review-queue-client";
import type { ReviewQueueListItemWire, ReviewQueueListResponse } from "../api/review-queue/types";

const ITEM: ReviewQueueListItemWire = {
  id: 42,
  verificationId: 10,
  applicationId: 20,
  reason: "AMBIGUOUS_BRAND",
  reasonText: "A reviewer must check the brand name or class and type against the label.",
  brandName: "Old Tom Distillery",
  classType: "Straight Bourbon Whiskey",
  beverageType: "spirits",
  labelVerdict: "REVIEW",
  createdAt: "2026-08-11T14:03:00.000Z",
  resolverStatus: "waiting",
};

/** One page of the list endpoint's real response shape (TRO-507). */
function page(items: ReviewQueueListItemWire[], nextCursor: string | null = null): ReviewQueueListResponse {
  return { items, nextCursor };
}

describe("ReviewQueueBrowser", () => {
  it("shows a loading state, then the list, fetching exactly once on mount", async () => {
    const fetchItems = vi.fn().mockResolvedValue(page([ITEM]));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    expect(screen.getByText(/Loading the review queue/)).toBeInTheDocument();
    expect(await screen.findByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(fetchItems).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state once loaded with no items", async () => {
    const fetchItems = vi.fn().mockResolvedValue(page([]));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);
    expect(await screen.findByText(/No items need review right now\./)).toBeInTheDocument();
  });

  it("shows a designed error panel with a retry affordance on failure", async () => {
    const fetchItems = vi.fn().mockRejectedValue(new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again."));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("LabelHunter could not load the review queue. Try again.");
  });

  it("retrying after a failure calls fetchItems again", async () => {
    const user = userEvent.setup();
    const fetchItems = vi
      .fn()
      .mockRejectedValueOnce(new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again."))
      .mockResolvedValueOnce(page([ITEM]));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(fetchItems).toHaveBeenCalledTimes(2);
  });

  it("a manual refresh re-fetches the list", async () => {
    const user = userEvent.setup();
    const fetchItems = vi.fn().mockResolvedValue(page([ITEM]));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(fetchItems).toHaveBeenCalledTimes(2);
  });

  it("keeps the list mounted and shows a Refreshing state while a manual refresh is in flight", async () => {
    // A promise this test controls the resolution of — same pattern
    // VerifyForm.test.tsx uses to assert a pending state deterministically.
    let resolveRefetch!: (page: ReviewQueueListResponse) => void;
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce(page([ITEM]))
      .mockImplementationOnce(() => new Promise<ReviewQueueListResponse>((resolve) => (resolveRefetch = resolve)));
    const user = userEvent.setup();
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    // The row and the Refresh button both stay in the document during the
    // in-flight refresh — swapping to the bare "loading" state here used to
    // unmount the whole list and throw away the reviewer's scroll position
    // on every refresh (CodeRabbit finding, PR #16 review round 2).
    expect(screen.getByTestId("review-queue-row-42")).toBeInTheDocument();
    const refreshButton = screen.getByRole("button", { name: "Refreshing…" });
    expect(refreshButton).toBeDisabled();

    resolveRefetch(page([ITEM]));
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("a failed manual refresh keeps the list on screen next to the error, instead of replacing it", async () => {
    // A refresh failure used to reach the same bare "error" state as the
    // initial load, discarding a working list the reviewer already had on
    // screen (CodeRabbit finding, local review round 3).
    const user = userEvent.setup();
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce(page([ITEM]))
      .mockRejectedValueOnce(new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again."));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("LabelHunter could not load the review queue. Try again.");
    expect(screen.getByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("says the list is not the whole queue, and loads the rest on demand (TRO-507)", async () => {
    const user = userEvent.setup();
    const second: ReviewQueueListItemWire = { ...ITEM, id: 43, brandName: "Second Winery" };
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce(page([ITEM], "cursor-for-page-two"))
      .mockResolvedValueOnce(page([second]));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    // The reviewer is told, before clicking anything, that more items
    // exist — a list that looks complete but is not is the failure this
    // ticket fixes (TH-R10/TH-R20).
    expect(screen.getByText(/More items are waiting\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByTestId("review-queue-row-43")).toBeInTheDocument();
    // The rows already read stay on screen — loading more appends.
    expect(screen.getByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(fetchItems).toHaveBeenLastCalledWith("cursor-for-page-two");
    // The end of the queue: no claim about more items, and no control.
    expect(screen.queryByText(/More items are waiting\./)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("offers no Load more control when the first page ends the queue", async () => {
    const fetchItems = vi.fn().mockResolvedValue(page([ITEM]));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.queryByText(/More items are waiting\./)).not.toBeInTheDocument();
  });

  it("keeps the rows and the cursor when loading more fails", async () => {
    const user = userEvent.setup();
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce(page([ITEM], "cursor-for-page-two"))
      .mockRejectedValueOnce(new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again."));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("LabelHunter could not load the review queue. Try again.");
    // Regression test: the reviewer clicked "Load more", not "Refresh" —
    // the panel must name the control they actually pressed, not always
    // claim a refresh failed (TH-R20: the real reason, never a
    // plausible-but-wrong one).
    expect(alert).toHaveTextContent("Could not load more items");
    expect(alert).not.toHaveTextContent("Could not refresh the review queue");
    expect(screen.getByTestId("review-queue-row-42")).toBeInTheDocument();
    // Still says the queue is deeper than what is on screen — a failed
    // page load must not make a partial list look complete.
    expect(screen.getByText(/More items are waiting\./)).toBeInTheDocument();
  });

  it("retrying Load more after a failed page load asks for the same cursor again", async () => {
    // The failed page load left the phase at "refresh-error", and
    // loadMore() only ran from "success" — so the Load more button rendered,
    // stayed enabled, and did nothing. The cursor was already held; only
    // the guard refused to use it (CodeRabbit finding, local review round 6).
    const user = userEvent.setup();
    const second: ReviewQueueListItemWire = { ...ITEM, id: 43, brandName: "Second Winery" };
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce(page([ITEM], "cursor-for-page-two"))
      .mockRejectedValueOnce(new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again."))
      .mockResolvedValueOnce(page([second]));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByTestId("review-queue-row-43")).toBeInTheDocument();
    // The retry reuses the cursor of the page that failed. Advancing it, or
    // dropping it, would skip the page the reviewer never received.
    expect(fetchItems).toHaveBeenNthCalledWith(3, "cursor-for-page-two");
    expect(fetchItems).toHaveBeenCalledTimes(3);
    // The rows already read stay on screen, and the error clears.
    expect(screen.getByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retrying after a failed refresh keeps the list mounted too, not only after a successful one", async () => {
    // refresh() checked only current.status === "success" before deciding
    // whether to keep rows mounted; retrying from "refresh-error" fell
    // through to the bare "loading" state and unmounted the list again
    // (CodeRabbit finding, local review round 4).
    let resolveRetry!: (page: ReviewQueueListResponse) => void;
    const user = userEvent.setup();
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce(page([ITEM]))
      .mockRejectedValueOnce(new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again."))
      .mockImplementationOnce(() => new Promise<ReviewQueueListResponse>((resolve) => (resolveRetry = resolve)));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeInTheDocument();

    resolveRetry(page([ITEM]));
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeEnabled();
  });
});
