// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
  it("renders exactly one Approve button and one Reject button, both enabled", () => {
    render(<ReviewActions reviewQueueId={42} submit={vi.fn()} onResolved={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("clicking Approve calls submit with APPROVED, disables both buttons while pending, then calls onResolved", async () => {
    const user = userEvent.setup();
    const { promise, resolve } = deferred<RecordDispositionResponse>();
    const submit = vi.fn().mockReturnValue(promise);
    const onResolved = vi.fn();
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(submit).toHaveBeenCalledWith(42, "APPROVED");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();

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

  it("on a 409 conflict, shows which decision already won instead of a bare conflict message", async () => {
    const user = userEvent.setup();
    const submit = vi
      .fn()
      .mockRejectedValue(new ReviewQueueClientError("CONFLICT", "Someone already recorded a decision on this item.", "REJECTED"));
    render(<ReviewActions reviewQueueId={42} submit={submit} onResolved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already rejected/i);
  });
});
