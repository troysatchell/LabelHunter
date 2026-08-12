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
    throughput: null,
    autoVerifiedShare: 0.75,
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
    // TRO-480: the caveat's own closing line must say WHAT "auto-verified"
    // means (decided with no Sonnet call and no human), never the vague
    // "needs a closer look" this line originally read (standing rule 26).
    expect(autoVerified).toHaveTextContent("Neither needed a person to check it.");
    expect(autoVerified.textContent).not.toMatch(/closer look/i);
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

  it("shows items/minute and the reciprocal per-item average once the batch has finished (TRO-544, PRD §3.8)", () => {
    render(<BatchProgressSummary progress={progress({ throughput: { itemsPerMinute: 16.67, avgMsPerItem: 3600 } })} />);
    const tile = screen.getByTestId("batch-stat-throughput");
    expect(tile).toHaveTextContent("16.67");
    expect(tile).toHaveTextContent("3.60s per label, averaged across the whole batch.");
  });

  it("shows 'Not measured yet' for throughput instead of a fabricated rate while the batch is still running", () => {
    render(<BatchProgressSummary progress={progress({ throughput: null })} />);
    const tile = screen.getByTestId("batch-stat-throughput");
    expect(tile).toHaveTextContent("Not measured yet");
    expect(tile).toHaveTextContent("LabelHunter reports this once the batch finishes.");
  });

  it("shows the auto-verified share as a percentage (CP-1 §4.5 step 3: 'the share of labels finished without a resolver call')", () => {
    render(<BatchProgressSummary progress={progress({ autoVerifiedShare: 0.72 })} />);
    const tile = screen.getByTestId("batch-stat-auto-verified-share");
    expect(tile).toHaveTextContent("72.0%");
    expect(tile).toHaveTextContent("Decided without Sonnet or a person");
  });

  it("shows 'Not measured yet' for the auto-verified share instead of a fabricated 0% before anything has processed", () => {
    render(<BatchProgressSummary progress={progress({ autoVerifiedShare: null })} />);
    expect(screen.getByTestId("batch-stat-auto-verified-share")).toHaveTextContent("Not measured yet");
  });

  it("shows a genuine 0% auto-verified share as a real measured rate, not as 'Not measured yet'", () => {
    // Regression: a naive `autoVerifiedShare ? ... : "Not measured yet"` check
    // would treat a real 0 as falsy and misreport it as unmeasured.
    render(<BatchProgressSummary progress={progress({ autoVerifiedShare: 0 })} />);
    expect(screen.getByTestId("batch-stat-auto-verified-share")).toHaveTextContent("0.0%");
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
    // The percentage check must be UNANCHORED (CodeRabbit finding, local
    // review round 1) — the banner's real text is a whole sentence
    // ("In progress. 4 of 10 labels processed."), so an anchored ^...$
    // pattern could never match regardless of whether a percentage crept
    // in somewhere inside it. This checks for one ANYWHERE in the text.
    render(<BatchProgressSummary progress={progress()} />);
    const banner = screen.getByTestId("batch-status-banner");
    expect(banner.textContent).not.toMatch(/claude-(haiku|sonnet)/i);
    expect(banner.textContent).not.toMatch(/\d+(\.\d+)?\s*%/);
  });
});
