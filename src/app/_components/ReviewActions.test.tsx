// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewActions } from "./ReviewActions";
import { ReviewQueueClientError } from "../_lib/review-queue-client";
import type { RecordDispositionResponse } from "../api/review-queue/types";

/** A promise this test controls the resolution of — same pattern
 * `VerifyForm.test.tsx` uses to assert a pending state deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const RECORDED: RecordDispositionResponse = { id: 42, disposition: "APPROVED", disposedAt: "2026-08-11T14:03:00.000Z" };

describe("ReviewActions — TH-R3, two large obvious buttons, no hidden actions", () => {
  // Restores console.error unconditionally, not only when a spying test's
  // own assertions all pass — a mid-test failure before the old inline
  // mockRestore() would have left every later test in this file running
  // with console.error silently mocked (CodeRabbit finding, local review
  // round 7).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders exactly one Approve button and one Reject button, both enabled", () => {
    render(<ReviewActions reviewQueueId={42} submit={vi.fn()} onResolved={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("has its status region in the DOM from first render, before any click (loading-state pass)", () => {
    // A live region only reliably announces content ADDED to it after it
    // already exists in the DOM (WAI-ARIA) — the per-phase mounted
    // banners this replaces carried their content in with them.
    render(<ReviewActions reviewQueueId={42} submit={vi.fn()} onResolved={vi.fn()} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("marks the buttons group busy while a decision is in flight, never the status line's wrapper", async () => {
    const user = userEvent.setup();
    const { promise, resolve } = deferred<RecordDispositionResponse>();
    const submit = vi.fn().mockReturnValue(promise);
    const { container } = render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(container.querySelector(".review-actions__buttons")).toHaveAttribute("aria-busy", "true");
    // aria-busy on an ancestor of the role="status" line would let
    // assistive tech withhold "Recording…" until the request is over
    // (WAI-ARIA) — the status line must not sit inside the busy region.
    expect(screen.getByRole("status").closest('[aria-busy="true"]')).toBeNull();

    resolve(RECORDED);
    await screen.findByText(/Recorded/);
    expect(container.querySelector(".review-actions__buttons")).toHaveAttribute("aria-busy", "false");
  });

  it("clicking Approve calls submit with APPROVED, disables both buttons while pending, then calls onResolved", async () => {
    const user = userEvent.setup();
    const { promise, resolve } = deferred<RecordDispositionResponse>();
    const submit = vi.fn().mockReturnValue(promise);
    const onResolved = vi.fn();
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(submit).toHaveBeenCalledWith(42, "APPROVED");
    // Regression test: the clicked button's own label swaps to
    // "Recording…" while pending, matching the "X-ing…" convention every
    // other submit button in this app uses — a click that only dims a
    // button gives a first-time user on a slow connection no way to tell
    // "it registered" from "it's broken". A screen-reader user gets the
    // same signal from the role="status" announcement.
    expect(screen.getByRole("button", { name: "Recording…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Recording…");

    resolve(RECORDED);
    await screen.findByText(/Recorded/);
    expect(onResolved).toHaveBeenCalledWith(RECORDED);
  });

  it("clicking Reject calls submit with REJECTED", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue({ ...RECORDED, disposition: "REJECTED" });
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(submit).toHaveBeenCalledWith(42, "REJECTED");
  });

  it("swaps the Reject button's own label to 'Recording…' while pending, not Approve's", async () => {
    const user = userEvent.setup();
    const { promise } = deferred<RecordDispositionResponse>();
    const submit = vi.fn().mockReturnValue(promise);
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByRole("button", { name: "Recording…" })).toBeDisabled();
    // Approve is disabled too (both buttons lock together), but keeps its
    // own resting label — only the button the user actually pressed
    // changes what it says.
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("shows a designed error panel on failure, re-enables the buttons, and never calls onResolved", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(new ReviewQueueClientError("SERVICE", "LabelHunter could not record this decision. Try again."));
    const onResolved = vi.fn();
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("LabelHunter could not record this decision. Try again.");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("on a 409 conflict, shows which decision already won instead of a bare conflict message, and leaves the buttons disabled", async () => {
    const user = userEvent.setup();
    const submit = vi
      .fn()
      .mockRejectedValue(new ReviewQueueClientError("CONFLICT", "Someone already recorded a decision on this item.", "REJECTED"));
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already rejected/i);
    // The server already recorded a decision — re-enabling here would leave
    // a dead action a retry can only ever 409 against (CodeRabbit finding,
    // PR #16 review round 2).
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("on a 409 conflict with no conflictDisposition, still shows a terminal message and leaves the buttons disabled", async () => {
    // The server's 409 body can omit `disposition` (review-queue-client.ts's
    // own `isRecordDispositionConflictResponse` allows it); this case must
    // not fall through to the generic, retryable error branch just because
    // there is no specific decision to name (CodeRabbit finding, local
    // review round 2).
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(new ReviewQueueClientError("CONFLICT", "Already decided."));
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already recorded a decision/i);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("commits the success state before calling onResolved, so a failure in onResolved cannot be mistaken for a record failure", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(RECORDED);
    // Asserts ordering directly, rather than making onResolved throw: `void
    // act(...)` in the click handler means a throw here would reject an
    // unobserved promise, not something `user.click()` itself surfaces
    // (CodeRabbit finding, PR #16 review round 2 — onResolved used to run
    // inside the same try/catch as the network call, so its own failures,
    // e.g. a router.push navigation error, were reported as "could not
    // record this decision" even though the decision had already recorded).
    const onResolved = vi.fn(() => {
      expect(screen.getByText(/Recorded/)).toBeInTheDocument();
    });
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onResolved).toHaveBeenCalledWith(RECORDED);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("logs, rather than throws, when onResolved itself fails — no unhandled rejection on the void-called act promise", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(RECORDED);
    const onResolved = vi.fn(() => {
      throw new Error("navigation failed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText(/Recorded/)).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith("onResolved threw after a successful review-queue decision", expect.any(Error));
  });

  it("also logs an asynchronous rejection from onResolved, not only a synchronous throw", async () => {
    // onResolved's type says it returns void, but nothing stops a caller
    // from passing an async function — a synchronous try/catch alone does
    // not observe a rejection that surfaces after onResolved has already
    // returned its own pending promise (CodeRabbit finding, local review
    // round 3).
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(RECORDED);
    const onResolved = vi.fn(async () => {
      throw new Error("async navigation failed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText(/Recorded/)).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith("onResolved threw after a successful review-queue decision", expect.any(Error));
  });
});
