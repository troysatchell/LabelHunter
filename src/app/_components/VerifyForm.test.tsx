// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VerifyForm } from "./VerifyForm";
import { VerifyClientError } from "../_lib/verify-client";
import type { VerifySuccessResponse } from "../api/verify/types";

function makeFile(name = "label.jpg"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
}

const SUCCESS_RESULT: VerifySuccessResponse = {
  applicationId: 1,
  verificationId: 1,
  labelVerdict: "PASS",
  headlineReason: null,
  headlineMessage: null,
  fields: [
    {
      field: "brand_name",
      fieldLabel: "Brand name",
      verdict: "MATCH",
      labelValue: "Old Tom Distillery",
      evidence: "OLD TOM DISTILLERY",
      reason: "Matches the application.",
      reviewReason: null,
    },
  ],
};

/** A promise this test controls the resolution of, so the loading state can
 * be asserted deterministically instead of racing a microtask. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText("Label photo"), makeFile());
  await user.type(screen.getByLabelText("Brand name"), "Old Tom Distillery");
  await user.type(screen.getByLabelText("Class/type"), "Straight Bourbon Whiskey");
  await user.type(screen.getByLabelText(/Alcohol content/), "45");
  await user.type(screen.getByLabelText("Net contents"), "750");
}

describe("VerifyForm — TH-R3, the primary flow is reachable with no hunting", () => {
  it("renders the upload control, all five fields, the beverage selector, and exactly one primary button", () => {
    render(<VerifyForm submit={vi.fn()} />);

    expect(screen.getByLabelText("Label photo")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Beverage type" })).toBeInTheDocument();
    expect(screen.getByLabelText("Beer")).toBeInTheDocument();
    expect(screen.getByLabelText("Wine")).toBeInTheDocument();
    expect(screen.getByLabelText("Spirits")).toBeInTheDocument();
    expect(screen.getByLabelText("Brand name")).toBeInTheDocument();
    expect(screen.getByLabelText("Class/type")).toBeInTheDocument();
    expect(screen.getByLabelText(/Alcohol content/)).toBeInTheDocument();
    expect(screen.getByLabelText("Net contents")).toBeInTheDocument();
    expect(screen.getByLabelText("Unit")).toBeInTheDocument();

    // Exactly one button on the whole screen — the Verify button. No second
    // action to hunt for.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
  });
});

describe("VerifyForm — the happy path", () => {
  it("submits the parsed field values, shows a loading state, then the results checklist", async () => {
    const user = userEvent.setup();
    const { promise, resolve } = deferred<VerifySuccessResponse>();
    const submit = vi.fn().mockReturnValue(promise);
    render(<VerifyForm submit={submit} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("button", { name: "Checking the label…" })).toBeDisabled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      beverageType: "beer",
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: "45",
      netContentsValue: "750",
      netContentsUnit: "mL",
    });
    expect(submit.mock.calls[0][0].imageFile.name).toBe("label.jpg");

    resolve(SUCCESS_RESULT);
    expect(await screen.findByTestId("label-verdict-banner")).toHaveTextContent("This label matches the application.");
  });

  it("reads the selected beverage type when it is not the default", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    render(<VerifyForm submit={submit} />);

    await user.click(screen.getByLabelText("Spirits"));
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByTestId("label-verdict-banner");
    expect(submit.mock.calls[0][0].beverageType).toBe("spirits");
  });
});

describe("VerifyForm — designed error states (TH-R20)", () => {
  it("shows a validation error and never calls submit when no photo is selected", async () => {
    const submit = vi.fn();
    const { container } = render(<VerifyForm submit={submit} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Brand name"), "Old Tom Distillery");
    await user.type(screen.getByLabelText("Class/type"), "Straight Bourbon Whiskey");
    await user.type(screen.getByLabelText("Net contents"), "750");

    // Dispatched directly on the form (bypassing native `required` UI, which
    // jsdom only enforces on a real click through a submit control) to
    // exercise this component's own JS-level guard, the last line of
    // defense behind the HTML5 `required` attributes.
    const form = container.querySelector("form");
    if (!form) throw new Error("expected a form element");
    fireEvent.submit(form);

    expect(await screen.findByRole("alert")).toHaveTextContent("Add a label photo before you verify.");
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows the EXTRACTION error panel on a HaikuExtractionError-classified rejection, and 'Try again' resubmits", async () => {
    const user = userEvent.setup();
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new VerifyClientError("EXTRACTION", "LabelHunter could not read this label. Take a clearer photo and try again."),
      )
      .mockResolvedValueOnce(SUCCESS_RESULT);
    render(<VerifyForm submit={submit} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Verify" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("LabelHunter could not read this label");
    expect(alert).toHaveTextContent("Take a clearer photo and try again.");
    expect(submit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("label-verdict-banner")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("shows the SERVICE error panel on an API failure/timeout (TRO-478), and 'Try again' resubmits", async () => {
    const user = userEvent.setup();
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new VerifyClientError("SERVICE", "LabelHunter took too long to respond. Check your connection and try again."),
      )
      .mockResolvedValueOnce(SUCCESS_RESULT);
    render(<VerifyForm submit={submit} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Verify" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(alert).toHaveTextContent("took too long to respond");
    expect(submit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("label-verdict-banner")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("classifies a rejection that is not a VerifyClientError as SERVICE, never as a raw crash", async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(new Error("unexpected"));
    render(<VerifyForm submit={submit} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Verify" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
  });
});
