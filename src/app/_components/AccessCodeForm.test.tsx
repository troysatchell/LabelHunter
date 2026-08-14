// @vitest-environment jsdom
/**
 * Tests for `AccessCodeFormView` (TRO-482 / LH-061). Tests the VIEW
 * component only — no `next/navigation` import in the component under
 * test, so no router mocking is needed (see the component's own header
 * comment for why `AccessCodeForm`, the thin router-connected wrapper, is
 * not separately unit tested).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessCodeFormView } from "./AccessCodeForm";

afterEach(() => {
  window.history.pushState({}, "", "/access-code");
});

describe("AccessCodeFormView", () => {
  it("renders a code field and a Continue button", () => {
    render(<AccessCodeFormView onSuccess={() => {}} />);
    expect(screen.getByLabelText("Access code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("shows the typed code in plain text, not masked", () => {
    // ACCESS_CODE is a shared, non-secret string handed out in an
    // invitation (PRD §8) — masking it only adds typo risk for a
    // first-time user typing from a printed invite, with no matching
    // security benefit.
    render(<AccessCodeFormView onSuccess={() => {}} />);
    expect(screen.getByLabelText("Access code")).toHaveAttribute("type", "text");
  });

  it("disables Continue until a code is entered", async () => {
    const user = userEvent.setup();
    render(<AccessCodeFormView onSuccess={() => {}} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.type(screen.getByLabelText("Access code"), "a");
    expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
  });

  it("calls onSuccess with the default next page (/) once the server accepts the code", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const submit = vi.fn().mockResolvedValue({ ok: true, message: null });
    render(<AccessCodeFormView submit={submit} onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText("Access code"), "correct-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("/"));
    expect(submit).toHaveBeenCalledWith("correct-code");
  });

  it("reads ?next= from the URL and passes it to onSuccess on a correct code", async () => {
    window.history.pushState({}, "", "/access-code?next=%2Fverify");
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const submit = vi.fn().mockResolvedValue({ ok: true, message: null });
    render(<AccessCodeFormView submit={submit} onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText("Access code"), "correct-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("/verify"));
  });

  it("refuses an absolute-URL ?next= and falls back to / (TRO-565 finding 1 — open redirect)", async () => {
    window.history.pushState({}, "", "/access-code?next=https%3A%2F%2Fevil.com");
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const submit = vi.fn().mockResolvedValue({ ok: true, message: null });
    render(<AccessCodeFormView submit={submit} onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText("Access code"), "correct-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("/"));
  });

  it("refuses a protocol-relative ?next= and falls back to / (TRO-565 finding 1 — open redirect)", async () => {
    window.history.pushState({}, "", "/access-code?next=%2F%2Fevil.com");
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const submit = vi.fn().mockResolvedValue({ ok: true, message: null });
    render(<AccessCodeFormView submit={submit} onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText("Access code"), "correct-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("/"));
  });

  it("shows a friendly, specific error panel when the server rejects the code — never a raw status code", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue({ ok: false, message: "That code did not work. Check it and try again." });
    render(<AccessCodeFormView submit={submit} onSuccess={() => {}} />);

    await user.type(screen.getByLabelText("Access code"), "wrong-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That code did not work");
    expect(alert.textContent).not.toMatch(/\b401\b/);
  });

  it("does not call onSuccess when the code is rejected", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const submit = vi.fn().mockResolvedValue({ ok: false, message: "wrong" });
    render(<AccessCodeFormView submit={submit} onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText("Access code"), "wrong-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("alert");

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("has its status region in the DOM from first render, before any submit (loading-state pass)", () => {
    // A live region only reliably announces content ADDED to it after it
    // already exists in the DOM (WAI-ARIA) — so the region must be here,
    // empty, before the submit fills it.
    render(<AccessCodeFormView onSuccess={() => {}} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces 'Checking the code…' to assistive tech while the submit is in flight", async () => {
    const user = userEvent.setup();
    let resolveSubmit!: (result: { ok: boolean; message: string | null }) => void;
    const submit = vi.fn().mockImplementation(() => new Promise((resolve) => (resolveSubmit = resolve)));
    render(<AccessCodeFormView submit={submit} onSuccess={vi.fn()} />);

    await user.type(screen.getByLabelText("Access code"), "some-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("status")).toHaveTextContent("Checking the code…");

    resolveSubmit({ ok: false, message: "wrong" });
    await screen.findByRole("alert");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("marks the form busy while the submit is in flight", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { container } = render(<AccessCodeFormView submit={submit} onSuccess={vi.fn()} />);

    await user.type(screen.getByLabelText("Access code"), "some-code");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(container.querySelector("form")).toHaveAttribute("aria-busy", "true");
  });
});
