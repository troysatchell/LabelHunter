// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorPanel } from "./ErrorPanel";
import type { VerifyErrorKind } from "../api/verify/types";

describe("ErrorPanel", () => {
  it.each<[VerifyErrorKind, string]>([
    ["VALIDATION", "Check the form"],
    ["IMAGE", "LabelHunter can't use this photo"],
    ["EXTRACTION", "LabelHunter could not read this label"],
    ["SERVICE", "Something went wrong"],
  ])("shows the right title for kind %s", (kind, expectedTitle) => {
    render(<ErrorPanel kind={kind} message="A specific, human-readable reason." onRetry={() => {}} />);
    expect(screen.getByText(expectedTitle)).toBeInTheDocument();
    expect(screen.getByText("A specific, human-readable reason.")).toBeInTheDocument();
  });

  it("announces itself to assistive tech (role=alert) — a designed state, not a toast (TH-R20)", () => {
    render(<ErrorPanel kind="SERVICE" message="Try again." onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("calls onRetry when the Try again button is pressed", async () => {
    const onRetry = vi.fn();
    render(<ErrorPanel kind="SERVICE" message="Try again." onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
