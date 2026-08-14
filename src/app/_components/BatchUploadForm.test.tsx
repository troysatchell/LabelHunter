// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BatchClientError, type BatchClientErrorKind } from "../_lib/batch-client";
import { BatchUploadForm } from "./BatchUploadForm";
import type { BatchPreviewSuccessResponse } from "../api/batch/preview/types";
import type { BatchStartSuccessResponse } from "../api/batch/start/types";

function csvFile(name = "manifest.csv"): File {
  return new File(["beverage_type,brand_name\nspirits,Old Tom"], name, { type: "text/csv" });
}

function imageFile(name = "bottle-01.jpg"): File {
  return new File(["fake-bytes"], name, { type: "image/jpeg" });
}

function cleanPreview(overrides: Partial<BatchPreviewSuccessResponse> = {}): BatchPreviewSuccessResponse {
  return {
    totalRows: 2,
    readyCount: 2,
    matched: [],
    unmatchedRows: [],
    unmatchedImages: [],
    invalidRows: [],
    ...overrides,
  };
}

function startSuccess(overrides: Partial<BatchStartSuccessResponse> = {}): BatchStartSuccessResponse {
  return {
    batchJobId: 42,
    totalRows: 2,
    queuedCount: 2,
    unmatchedRows: [],
    unmatchedImages: [],
    invalidRows: [],
    skippedImages: [],
    ...overrides,
  };
}

async function selectManifestAndImages() {
  await userEvent.upload(screen.getByLabelText("CSV manifest"), csvFile());
  await userEvent.upload(screen.getByLabelText("Label images"), [imageFile("a.jpg"), imageFile("b.jpg")]);
}

describe("BatchUploadForm", () => {
  it("shows a plain-English validation message when no manifest is selected — no network call", async () => {
    const submitPreview = vi.fn();
    render(<BatchUploadForm submitPreview={submitPreview} onStarted={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));

    expect(screen.getByText("Add a CSV manifest file before you preview.")).toBeInTheDocument();
    expect(submitPreview).not.toHaveBeenCalled();
  });

  it("shows a plain-English validation message when no images are selected", async () => {
    const submitPreview = vi.fn();
    render(<BatchUploadForm submitPreview={submitPreview} onStarted={vi.fn()} />);

    await userEvent.upload(screen.getByLabelText("CSV manifest"), csvFile());
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));

    expect(screen.getByText(/Add label images before you preview/)).toBeInTheDocument();
    expect(submitPreview).not.toHaveBeenCalled();
  });

  it("previews a clean upload and shows the ready count and a Start batch button", async () => {
    const submitPreview = vi.fn(async () => cleanPreview());
    render(<BatchUploadForm submitPreview={submitPreview} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));

    expect(await screen.findByTestId("batch-preview-summary")).toHaveTextContent("2 of 2 rows ready to process.");
    expect(screen.getByRole("button", { name: "Start batch (2)" })).toBeInTheDocument();
    expect(screen.queryByTestId("batch-preview-problems")).not.toBeInTheDocument();
  });

  it("shows the malformed-CSV designed error state, never a raw crash (TH-R20)", async () => {
    const submitPreview = vi.fn(async () => {
      throw new BatchClientError("MALFORMED_CSV", "This manifest is missing a required column.");
    });
    render(<BatchUploadForm submitPreview={submitPreview} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This manifest is missing a required column.");
    expect(screen.getByText("LabelHunter can't read this manifest")).toBeInTheDocument();
  });

  it("shows the malformed-zip designed error state", async () => {
    const submitPreview = vi.fn(async () => {
      throw new BatchClientError("MALFORMED_ZIP", "This zip file is damaged.");
    });
    render(<BatchUploadForm submitPreview={submitPreview} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This zip file is damaged.");
    expect(screen.getByText("LabelHunter can't read this zip file")).toBeInTheDocument();
  });

  it("reports unmatched rows, unmatched images, and invalid rows — never silently dropped (TH-R20)", async () => {
    const submitPreview = vi.fn(async () =>
      cleanPreview({
        totalRows: 3,
        readyCount: 1,
        unmatchedRows: [{ row: { rowNumber: 2, beverageType: "beer", brandName: "Hopyard Co", classType: "IPA", alcoholContentPercent: 5, netContentsValue: 355, netContentsUnit: "mL", imageFilename: "missing.jpg" }, reason: "No image named missing.jpg was uploaded." }],
        unmatchedImages: [{ image: { filename: "orphan.jpg", sizeBytes: 100 }, reason: "No manifest row names this image." }],
        invalidRows: [{ rowNumber: 4, message: "beverage_type must be one of beer, wine, spirits." }],
      }),
    );
    render(<BatchUploadForm submitPreview={submitPreview} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));

    const problems = await screen.findByTestId("batch-preview-problems");
    expect(problems).toHaveTextContent("Row 2 (Hopyard Co): No image named missing.jpg was uploaded.");
    expect(problems).toHaveTextContent("orphan.jpg: No manifest row names this image.");
    expect(problems).toHaveTextContent("Row 4: beverage_type must be one of beer, wine, spirits.");
  });

  it("does not show a Start batch button when nothing is ready — no dead end left unexplained", async () => {
    const submitPreview = vi.fn(async () => cleanPreview({ readyCount: 0 }));
    render(<BatchUploadForm submitPreview={submitPreview} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));

    await screen.findByTestId("batch-preview-summary");
    expect(screen.queryByRole("button", { name: /Start batch/ })).not.toBeInTheDocument();
    expect(screen.getByText("Fix the problems above, then upload again.")).toBeInTheDocument();
  });

  it("resets a stale preview when a file input changes afterward, so 'Start batch' never submits an unpreviewed upload (CodeRabbit finding, local review round 1)", async () => {
    const submitPreview = vi.fn(async () => cleanPreview());
    render(<BatchUploadForm submitPreview={submitPreview} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));
    expect(await screen.findByRole("button", { name: "Start batch (2)" })).toBeInTheDocument();

    // The user picks a different image after already previewing — the
    // stale preview (and its "Start batch" button) must disappear rather
    // than stay on screen describing an upload that is no longer selected.
    await userEvent.upload(screen.getByLabelText("Label images"), imageFile("c.jpg"));

    expect(screen.queryByRole("button", { name: /Start batch/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("batch-preview-summary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview batch" })).toBeInTheDocument();
  });

  it("starts the batch and shows the confirmation, calling onStarted only when the user clicks through", async () => {
    const submitPreview = vi.fn(async () => cleanPreview());
    const submitStart = vi.fn<(formData: FormData) => Promise<BatchStartSuccessResponse>>(async () => startSuccess());
    const onStarted = vi.fn();
    render(<BatchUploadForm submitPreview={submitPreview} submitStart={submitStart} onStarted={onStarted} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start batch (2)" }));

    const started = await screen.findByTestId("batch-started");
    expect(started).toHaveTextContent("2 labels are now processing.");
    expect(onStarted).not.toHaveBeenCalled();

    // "Start batch" resubmits the SAME files the preview was built from
    // (CodeRabbit finding, local review round 1) — the server re-derives
    // pairing from this upload rather than trusting a client-held decision.
    const sentFormData = submitStart.mock.calls[0][0];
    expect((sentFormData.get("manifest") as File).name).toBe("manifest.csv");
    expect(sentFormData.getAll("images").map((file) => (file as File).name)).toEqual(["a.jpg", "b.jpg"]);

    await userEvent.click(screen.getByRole("button", { name: "View batch progress" }));
    expect(onStarted).toHaveBeenCalledWith(42);
  });

  it("reports skipped images in the started confirmation — never silently dropped (TH-R20)", async () => {
    const submitPreview = vi.fn(async () => cleanPreview());
    const submitStart = vi.fn(async () => startSuccess({ queuedCount: 1, skippedImages: [{ filename: "corrupt.jpg", rowNumber: 2, reason: "LabelHunter cannot open this file." }] }));
    render(<BatchUploadForm submitPreview={submitPreview} submitStart={submitStart} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start batch (2)" }));

    const skipped = await screen.findByTestId("batch-skipped-images");
    expect(skipped).toHaveTextContent("corrupt.jpg: LabelHunter cannot open this file.");
  });

  it("keeps the preview visible and shows a start-specific error when starting fails, allowing retry", async () => {
    const submitPreview = vi.fn(async () => cleanPreview());
    const submitStart = vi.fn(async () => {
      throw new BatchClientError("NO_READY_ROWS", "No rows are ready to start.");
    });
    render(<BatchUploadForm submitPreview={submitPreview} submitStart={submitStart} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start batch (2)" }));

    expect(await screen.findByText("No rows are ready to start.")).toBeInTheDocument();
    // The preview itself, and its Start button, are still on screen.
    expect(screen.getByRole("button", { name: "Start batch (2)" })).toBeInTheDocument();
  });

  it("names the real reason when starting fails on a key-protection rejection (PRD §8), not a generic title", async () => {
    // Regression test: the start-error title used to be hardcoded
    // regardless of kind. A reviewer who hit RATE_LIMITED or
    // BUDGET_EXHAUSTED while starting a batch saw only "Could not start
    // this batch" — the same specific title the preview-error panel
    // already shows for these two kinds (see PREVIEW_ERROR_TITLE) never
    // reached the start-error panel.
    const submitPreview = vi.fn(async () => cleanPreview());
    const submitStart = vi.fn(async () => {
      // "BUDGET_EXHAUSTED" is a real kind the server can send (PRD §8's
      // key-protection guard) but is not yet part of the narrower
      // BatchClientErrorKind type union — the same unchecked cast
      // batch-client.ts's own request handlers already use.
      throw new BatchClientError("BUDGET_EXHAUSTED" as BatchClientErrorKind, "LabelHunter has used its budget for today. Try again tomorrow.");
    });
    render(<BatchUploadForm submitPreview={submitPreview} submitStart={submitStart} onStarted={vi.fn()} />);

    await selectManifestAndImages();
    await userEvent.click(screen.getByRole("button", { name: "Preview batch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start batch (2)" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("LabelHunter has reached today's limit");
    expect(alert).toHaveTextContent("LabelHunter has used its budget for today. Try again tomorrow.");
  });
});
