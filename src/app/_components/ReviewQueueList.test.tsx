// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { ReviewQueueList } from "./ReviewQueueList";
import type { ReviewQueueListItemWire } from "../api/review-queue/types";
import type Link from "next/link";

// next/link renders a plain <a> and drops `prefetch` before it reaches the
// DOM, so the prop cannot be asserted through the rendered output. This
// stub surfaces it as a data attribute — the same move the CI-workflow
// tests make when they assert configuration rather than behavior. TRO-577
// exists because the DEFAULT prefetch fired a speculative server render
// per row as it scrolled into view; this pins the opt-out.
vi.mock("next/link", () => ({
  default: ({ prefetch, children, ...rest }: ComponentProps<typeof Link>) => (
    <a {...(rest as Record<string, unknown>)} data-prefetch={String(prefetch)}>
      {children}
    </a>
  ),
}));

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
    const link = screen.getByRole("link", { name: "Review this item: Old Tom Distillery (#42)" });
    expect(link).toHaveAttribute("href", "/review-queue/42");

    const time = row.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-08-11T14:03:00.000Z");
  });

  it("disables viewport prefetch on every row link (TRO-577 — the scroll-hitch fix)", () => {
    render(<ReviewQueueList items={[ITEM]} />);
    const link = screen.getByRole("link", { name: "Review this item: Old Tom Distillery (#42)" });
    // `false`, not `undefined`: undefined is the default, which prefetches
    // on viewport entry — the exact behavior this ticket removes.
    expect(link).toHaveAttribute("data-prefetch", "false");
  });

  it.each([
    ["checking", "LabelHunter is checking this item now. Refresh in a moment."],
    ["skipped", "LabelHunter did not check this item. Read the label yourself."],
    ["suggested", "LabelHunter has a suggestion for this item."],
    ["waiting", "LabelHunter has not checked this item yet."],
  ] as const)("says in plain words what the resolver has done when the status is %s (TRO-512)", (resolverStatus, sentence) => {
    // CP-3 §3.3: a reserved row and a capped row both used to render as
    // "no suggestion", and a reviewer could not tell "wait a moment" from
    // "nothing is coming."
    render(<ReviewQueueList items={[{ ...ITEM, resolverStatus }]} />);
    expect(screen.getByTestId("review-queue-row-42")).toHaveTextContent(sentence);
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
