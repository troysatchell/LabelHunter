// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ASSIST_FAILED_MESSAGE, ASSIST_NOTHING_READ_MESSAGE, VerifyForm } from "./VerifyForm";
import { VerifyClientError } from "../_lib/verify-client";
import type { ExtractSuccessResponse } from "../api/extract/types";
import type { VerifySuccessResponse } from "../api/verify/types";

function makeFile(name = "label.jpg"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
}

/** A prefill response reading nothing — the assist stands down and every
 * pre-existing test's flow runs exactly as it did before TRO-576. Every
 * test that is not ABOUT the assist injects this. */
function inertExtract() {
  return vi.fn(
    async (): Promise<ExtractSuccessResponse> => ({
      outcome: "prefill",
      message: null,
      fields: {
        beverageType: null,
        brandName: null,
        classType: null,
        alcoholContentPercent: null,
        netContentsValue: null,
        netContentsUnit: null,
      },
    }),
  );
}

/** The assist's happy-path fixture: everything on OLD TOM's label. */
function fullPrefill(): ExtractSuccessResponse {
  return {
    outcome: "prefill",
    message: null,
    fields: {
      beverageType: "spirits",
      brandName: "Old Tom Distillery",
      classType: "Kentucky Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    },
  };
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
    render(<VerifyForm submit={vi.fn()} extract={inertExtract()} />);

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
    render(<VerifyForm submit={submit} extract={inertExtract()} />);

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
    render(<VerifyForm submit={submit} extract={inertExtract()} />);

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
    const { container } = render(<VerifyForm submit={submit} extract={inertExtract()} />);
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
    render(<VerifyForm submit={submit} extract={inertExtract()} />);

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
    render(<VerifyForm submit={submit} extract={inertExtract()} />);

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
    render(<VerifyForm submit={submit} extract={inertExtract()} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Verify" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
  });
});

describe("VerifyForm — auto-fill assist (TRO-576)", () => {
  it("fills the fields from the photo, marks each one, and says what it did", async () => {
    const user = userEvent.setup();
    const extract = vi.fn(async () => fullPrefill());
    render(<VerifyForm submit={vi.fn()} extract={extract} />);

    await user.upload(screen.getByLabelText("Label photo"), makeFile());

    await waitFor(() =>
      expect(screen.getByTestId("verify-assist")).toHaveTextContent("LabelHunter filled 5 fields from your photo."),
    );
    expect(extract).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Brand name")).toHaveValue("Old Tom Distillery");
    expect(screen.getByLabelText("Class/type")).toHaveValue("Kentucky Straight Bourbon Whiskey");
    expect(screen.getByLabelText(/Alcohol content/)).toHaveValue(45);
    expect(screen.getByLabelText("Net contents")).toHaveValue(750);
    expect(screen.getByLabelText("Unit")).toHaveValue("mL");
    expect(screen.getByLabelText("Spirits")).toBeChecked();
    expect(screen.getAllByText("Read from your photo")).toHaveLength(5);
  });

  it("never overwrites a field the agent already typed — their typing wins", async () => {
    const user = userEvent.setup();
    const extract = vi.fn(async () => fullPrefill());
    render(<VerifyForm submit={vi.fn()} extract={extract} />);

    await user.type(screen.getByLabelText("Brand name"), "My Own Entry");
    await user.upload(screen.getByLabelText("Label photo"), makeFile());

    await waitFor(() => expect(screen.getByTestId("verify-assist")).toHaveTextContent(/filled 4 fields/));
    expect(screen.getByLabelText("Brand name")).toHaveValue("My Own Entry");
    // The untouched fields still filled.
    expect(screen.getByLabelText("Class/type")).toHaveValue("Kentucky Straight Bourbon Whiskey");
  });

  it("clears a field's 'Read from your photo' note the moment the agent edits it", async () => {
    const user = userEvent.setup();
    render(<VerifyForm submit={vi.fn()} extract={vi.fn(async () => fullPrefill())} />);

    await user.upload(screen.getByLabelText("Label photo"), makeFile());
    await waitFor(() => expect(screen.getAllByText("Read from your photo")).toHaveLength(5));

    await user.type(screen.getByLabelText("Brand name"), " Reserve");

    expect(screen.getAllByText("Read from your photo")).toHaveLength(4);
  });

  it("says so plainly when the photo is unreadable, and fills nothing", async () => {
    const user = userEvent.setup();
    const unreadable: ExtractSuccessResponse = {
      outcome: "unreadable",
      message: "LabelHunter could not read this photo clearly. Fill in the fields yourself.",
      fields: fullPrefill().fields,
    };
    render(<VerifyForm submit={vi.fn()} extract={vi.fn(async () => unreadable)} />);

    await user.upload(screen.getByLabelText("Label photo"), makeFile());

    await waitFor(() =>
      expect(screen.getByTestId("verify-assist")).toHaveTextContent("could not read this photo clearly"),
    );
    // Unreadable means untouched: even though the wire fields carry
    // values, none may be applied.
    expect(screen.getByLabelText("Brand name")).toHaveValue("");
    expect(screen.queryByText("Read from your photo")).not.toBeInTheDocument();
  });

  it("stands down to one quiet sentence when the assist call fails — the manual flow is untouched", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => SUCCESS_RESULT);
    render(<VerifyForm submit={submit} extract={vi.fn(async () => Promise.reject(new Error("boom")))} />);

    await fillRequiredFields(user);
    await waitFor(() => expect(screen.getByTestId("verify-assist")).toHaveTextContent(ASSIST_FAILED_MESSAGE));

    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByTestId("label-verdict-banner")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("says so when the photo was readable but no field could be read", async () => {
    const user = userEvent.setup();
    render(<VerifyForm submit={vi.fn()} extract={inertExtract()} />);

    await user.upload(screen.getByLabelText("Label photo"), makeFile());

    await waitFor(() => expect(screen.getByTestId("verify-assist")).toHaveTextContent(ASSIST_NOTHING_READ_MESSAGE));
  });

  it("a newer photo's reading supersedes a slower older one — the stale result never lands", async () => {
    const user = userEvent.setup();
    const first = deferred<ExtractSuccessResponse>();
    const extract = vi
      .fn<(imageFile: File) => Promise<ExtractSuccessResponse>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(fullPrefill());
    render(<VerifyForm submit={vi.fn()} extract={extract} />);

    const fileInput = screen.getByLabelText("Label photo");
    await user.upload(fileInput, makeFile("one.jpg"));
    await user.upload(fileInput, makeFile("two.jpg"));

    await waitFor(() => expect(screen.getByTestId("verify-assist")).toHaveTextContent(/filled 5 fields/));

    // The FIRST (stale) response resolves late, with a different brand —
    // it must not overwrite the newer reading.
    first.resolve({
      ...fullPrefill(),
      fields: { ...fullPrefill().fields, brandName: "Stale Brand" },
    });
    await waitFor(() => expect(extract).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Brand name")).toHaveValue("Old Tom Distillery");
  });
});
