// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewQueueList } from "./ReviewQueueList";
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

describe("ReviewQueueList", () => {
  it("renders a designed empty state when nothing needs review — not a blank page", () => {
    render(<ReviewQueueList items={[]} />);
    expect(screen.getByText(/No items need review right now\./)).toBeInTheDocument();
  });

  it("renders one row per item with its reason, brief context, and a link to the review page", () => {
    render(<ReviewQueueList items={[ITEM]} />);

    const row = screen.getByTestId("review-queue-row-42");
    expect(row).toHaveTextContent("A reviewer must check the brand name or class and type against the label.");
    expect(row).toHaveTextContent("Old Tom Distillery");
    expect(row).toHaveTextContent("Straight Bourbon Whiskey");
    expect(row).toHaveTextContent("Aug 11, 2026, 2:03 PM UTC");

    // Exact accessible name, not a generic match — every row otherwise
    // shared the same name "Review this item", so a screen-reader user
    // listing the page's links could not tell rows apart (CodeRabbit
    // finding, local review round 2).
    const link = screen.getByRole("link", { name: "Review this item: Old Tom Distillery" });
    expect(link).toHaveAttribute("href", "/review-queue/42");

    const time = row.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-08-11T14:03:00.000Z");
  });

  it("renders one row per item, in the order given — the caller (oldest-first API) decides order", () => {
    const second: ReviewQueueListItemWire = { ...ITEM, id: 43, brandName: "Second Winery" };
    render(<ReviewQueueList items={[ITEM, second]} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Old Tom Distillery");
    expect(rows[1]).toHaveTextContent("Second Winery");
  });
});
