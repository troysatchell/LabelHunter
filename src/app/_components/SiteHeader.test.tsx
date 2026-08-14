// @vitest-environment jsdom
/**
 * Site header tests (Troy's direct request, 2026-08-13).
 *
 * Renders `SiteHeaderView`, not `SiteHeader` — the view takes the path as
 * a prop, so these tests need no Next router context (the same reason
 * `AccessCodeForm.test.tsx` renders `AccessCodeFormView`).
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isCurrent, SiteHeaderView } from "./SiteHeader";

describe("isCurrent", () => {
  it("marks the screen the visitor is on", () => {
    expect(isCurrent("/batch", "/batch")).toBe(true);
    expect(isCurrent("/review-queue", "/review-queue")).toBe(true);
    expect(isCurrent("/", "/")).toBe(true);
  });

  it("keeps a detail page inside its own section", () => {
    expect(isCurrent("/review-queue/12", "/review-queue")).toBe(true);
    expect(isCurrent("/batch/7", "/batch")).toBe(true);
    // A verification detail page belongs to the Verify flow.
    expect(isCurrent("/verify/12", "/")).toBe(true);
  });

  it("marks exactly one screen at a time", () => {
    // The regression this rule exists for: every path starts with "/", so
    // a plain prefix test would mark Verify on every screen in the app.
    expect(isCurrent("/batch", "/")).toBe(false);
    expect(isCurrent("/review-queue/12", "/")).toBe(false);
    expect(isCurrent("/batch/7", "/review-queue")).toBe(false);
  });
});

describe("SiteHeaderView", () => {
  it("shows the wordmark and every main screen, from any screen", () => {
    render(<SiteHeaderView pathname="/batch/7" />);

    expect(screen.getByRole("link", { name: "LabelHunter" })).toHaveAttribute("href", "/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Verify" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Batch" })).toHaveAttribute("href", "/batch");
    expect(within(nav).getByRole("link", { name: "Review queue" })).toHaveAttribute("href", "/review-queue");
  });

  it("marks the current screen for assistive tech, and only that one", () => {
    render(<SiteHeaderView pathname="/review-queue/12" />);

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Review queue" })).toHaveAttribute("aria-current", "page");
    // Absent, never aria-current="false" — React renders that string as a
    // real value, which assistive tech reads as an answer.
    expect(within(nav).getByRole("link", { name: "Verify" })).not.toHaveAttribute("aria-current");
    expect(within(nav).getByRole("link", { name: "Batch" })).not.toHaveAttribute("aria-current");
  });

  it("is a banner landmark, so a screen reader can skip it", () => {
    render(<SiteHeaderView pathname="/" />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});
