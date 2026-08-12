// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BatchProgressSummary } from "./BatchProgressSummary";
import type { BatchProgressResponse } from "../api/batch/[batchJobId]/types";

function progress(overrides: Partial<BatchProgressResponse> = {}): BatchProgressResponse {
  return {
    batchJobId: 7,
    status: "RUNNING",
    totalCount: 10,
    processedCount: 4,
    autoVerifiedCount: 3,
    passCount: 2,
    failCount: 1,
    resolvedBySonnetCount: 1,
    needsHumanCount: 0,
    failedCount: 0,
    startedAt: "2026-08-12T00:00:00.000Z",
    completedAt: null,
    latency: { count: 4, avgMs: 3200, p95Ms: 4800 },
    rateLimitBackoff: { active: false, itemCount: 0 },
    results: [],
    ...overrides,
  };
}

describe("BatchProgressSummary", () => {
  it("shows the live status banner with a processed/total count", () => {
    render(<BatchProgressSummary progress={progress()} />);
    const banner = screen.getByTestId("batch-status-banner");
    expect(banner).toHaveTextContent("In progress.");
    expect(banner).toHaveTextContent("4 of 10 labels processed.");
  });

  it("shows the four PRD-named summary counts, each labeled plainly", () => {
    render(<BatchProgressSummary progress={progress()} />);
    expect(screen.getByTestId("batch-stat-processed")).toHaveTextContent("4 / 10");
    expect(screen.getByTestId("batch-stat-auto-verified")).toHaveTextContent("3");
    expect(screen.getByTestId("batch-stat-resolved-by-sonnet")).toHaveTextContent("1");
    expect(screen.getByTestId("batch-stat-needs-human")).toHaveTextContent("0");
  });

  it("never presents auto-verified as though it means 'passed' — shows the pass/fail split alongside it (CP-3 §7.1)", () => {
    render(<BatchProgressSummary progress={progress()} />);
    const autoVerified = screen.getByTestId("batch-stat-auto-verified");
    expect(autoVerified).toHaveTextContent("2 matched.");
    expect(autoVerified).toHaveTextContent("1 did not.");
  });

  it("shows avg and p95 latency formatted, once measured", () => {
    render(<BatchProgressSummary progress={progress()} />);
    expect(screen.getByTestId("batch-stat-avg-latency")).toHaveTextContent("3.20s");
    expect(screen.getByTestId("batch-stat-p95-latency")).toHaveTextContent("4.80s");
  });

  it("shows 'Not measured yet' instead of a fabricated number when latency is null", () => {
    render(<BatchProgressSummary progress={progress({ latency: null })} />);
    expect(screen.getByTestId("batch-stat-avg-latency")).toHaveTextContent("Not measured yet");
    expect(screen.getByTestId("batch-stat-p95-latency")).toHaveTextContent("Not measured yet");
  });

  it("shows the partial-failure notice only when failedCount > 0 (TH-R20 designed state)", () => {
    const { rerender } = render(<BatchProgressSummary progress={progress({ failedCount: 0 })} />);
    expect(screen.queryByTestId("batch-partial-failure-notice")).not.toBeInTheDocument();

    rerender(<BatchProgressSummary progress={progress({ failedCount: 2 })} />);
    const notice = screen.getByTestId("batch-partial-failure-notice");
    expect(notice).toHaveTextContent("2 labels could not be processed automatically.");
  });

  it("shows the rate-limit backoff notice only when active, and never claims a specific cause it cannot confirm (TH-R20 designed state)", () => {
    const { rerender } = render(<BatchProgressSummary progress={progress({ rateLimitBackoff: { active: false, itemCount: 0 } })} />);
    expect(screen.queryByTestId("batch-backoff-notice")).not.toBeInTheDocument();

    rerender(<BatchProgressSummary progress={progress({ rateLimitBackoff: { active: true, itemCount: 3 } })} />);
    const notice = screen.getByTestId("batch-backoff-notice");
    expect(notice).toHaveTextContent("pausing before it tries 3 labels again");
    expect(notice).toHaveTextContent("No action is needed");
  });

  it("never shows a raw model identifier or a bare confidence number in the status banner", () => {
    render(<BatchProgressSummary progress={progress()} />);
    const banner = screen.getByTestId("batch-status-banner");
    expect(banner.textContent).not.toMatch(/claude-(haiku|sonnet)|^\d+(\.\d+)?%$/i);
  });
});
