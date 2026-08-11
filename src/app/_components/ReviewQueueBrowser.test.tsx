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
});
