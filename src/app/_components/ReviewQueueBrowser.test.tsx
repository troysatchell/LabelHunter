// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueueBrowser } from "./ReviewQueueBrowser";
import { ReviewQueueClientError } from "../_lib/review-queue-client";
import type { ReviewQueueListItemWire } from "../api/review-queue/types";

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
};

describe("ReviewQueueBrowser", () => {
  it("shows a loading state, then the list, fetching exactly once on mount", async () => {
    const fetchItems = vi.fn().mockResolvedValue([ITEM]);
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    expect(screen.getByText(/Loading the review queue/)).toBeInTheDocument();
    expect(await screen.findByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(fetchItems).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state once loaded with no items", async () => {
    const fetchItems = vi.fn().mockResolvedValue([]);
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
      .mockResolvedValueOnce([ITEM]);
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(fetchItems).toHaveBeenCalledTimes(2);
  });

  it("a manual refresh re-fetches the list", async () => {
    const user = userEvent.setup();
    const fetchItems = vi.fn().mockResolvedValue([ITEM]);
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(fetchItems).toHaveBeenCalledTimes(2);
  });

  it("keeps the list mounted and shows a Refreshing state while a manual refresh is in flight", async () => {
    // A promise this test controls the resolution of — same pattern
    // VerifyForm.test.tsx uses to assert a pending state deterministically.
    let resolveRefetch!: (items: ReviewQueueListItemWire[]) => void;
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce([ITEM])
      .mockImplementationOnce(() => new Promise<ReviewQueueListItemWire[]>((resolve) => (resolveRefetch = resolve)));
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

    resolveRefetch([ITEM]);
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("a failed manual refresh keeps the list on screen next to the error, instead of replacing it", async () => {
    // A refresh failure used to reach the same bare "error" state as the
    // initial load, discarding a working list the reviewer already had on
    // screen (CodeRabbit finding, local review round 3).
    const user = userEvent.setup();
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce([ITEM])
      .mockRejectedValueOnce(new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again."));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("LabelHunter could not load the review queue. Try again.");
    expect(screen.getByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("retrying after a failed refresh keeps the list mounted too, not only after a successful one", async () => {
    // refresh() checked only current.status === "success" before deciding
    // whether to keep rows mounted; retrying from "refresh-error" fell
    // through to the bare "loading" state and unmounted the list again
    // (CodeRabbit finding, local review round 4).
    let resolveRetry!: (items: ReviewQueueListItemWire[]) => void;
    const user = userEvent.setup();
    const fetchItems = vi
      .fn()
      .mockResolvedValueOnce([ITEM])
      .mockRejectedValueOnce(new ReviewQueueClientError("SERVICE", "LabelHunter could not load the review queue. Try again."))
      .mockImplementationOnce(() => new Promise<ReviewQueueListItemWire[]>((resolve) => (resolveRetry = resolve)));
    render(<ReviewQueueBrowser fetchItems={fetchItems} />);

    await screen.findByTestId("review-queue-row-42");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByTestId("review-queue-row-42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeInTheDocument();

    resolveRetry([ITEM]);
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeEnabled();
  });
});
