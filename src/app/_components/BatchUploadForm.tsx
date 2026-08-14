"use client";

/**
 * The batch upload screen's one form (LH-042 / TRO-475, PRD §5: "manifest
 * upload → pairing preview → run"). One obvious primary flow (TH-R3):
 * choose a CSV manifest and label images, preview the pairing, then start
 * the batch.
 *
 * Carries two of this ticket's four designed batch-scoped error states
 * (TH-R20): a malformed CSV (`preview-error`, `kind: "MALFORMED_CSV"`) and
 * unpairable rows/images (`unmatchedRows`/`unmatchedImages`, reported
 * inside a successful preview, never a request failure — mirroring
 * `/api/batch/preview`'s own design). The other two designed states
 * (partial batch failure, rate-limit backoff) belong to the progress page
 * this form hands off to (`BatchProgressSummary.tsx`), once a batch is
 * actually running.
 *
 * Uncontrolled file inputs, read via refs on submit — the same reasoning
 * `VerifyForm.tsx` states for its own single file input, extended to three.
 * "Start batch" re-reads the SAME inputs (never cleared after a preview) to
 * resubmit the identical upload — the server re-derives pairing from it
 * rather than trusting a client-held decision (standing rule 13).
 */
import { useRef, useState, type FormEvent } from "react";
import { BatchClientError, startBatch, submitBatchPreview } from "../_lib/batch-client";
import type { BatchPreviewSuccessResponse } from "../api/batch/preview/types";
import type { BatchStartSuccessResponse } from "../api/batch/start/types";

interface ErrorInfo {
  kind: string;
  message: string;
}

type Phase =
  | { status: "idle" }
  | { status: "previewing" }
  | { status: "preview"; result: BatchPreviewSuccessResponse; starting: boolean; startError: ErrorInfo | null }
  | { status: "preview-error"; kind: string; message: string }
  | { status: "started"; result: BatchStartSuccessResponse };

export interface BatchUploadFormProps {
  /** Injected in tests; defaults to the real network call. */
  submitPreview?: (formData: FormData) => Promise<BatchPreviewSuccessResponse>;
  submitStart?: (formData: FormData) => Promise<BatchStartSuccessResponse>;
  /** Called once a batch has actually started, with its id — the caller
   * (`BatchUploadWorkspace.tsx`) owns navigation, matching the established
   * `useRouter`-isolation pattern `ReviewItemWorkspace.tsx` already uses. */
  onStarted: (batchJobId: number) => void;
}

const PREVIEW_ERROR_TITLE: Record<string, string> = {
  VALIDATION: "Check your upload",
  MALFORMED_CSV: "LabelHunter can't read this manifest",
  MALFORMED_ZIP: "LabelHunter can't read this zip file",
  NO_READY_ROWS: "Nothing is ready to start",
  SERVICE: "Something went wrong",
  // TRO-482 / LH-061, PRD §8 — the key-protection guard's two rejection
  // states, matching src/app/_components/ErrorPanel.tsx's own titles for
  // the same two kinds on the verify screen.
  RATE_LIMITED: "Too many requests right now",
  BUDGET_EXHAUSTED: "LabelHunter has reached today's limit",
};

function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof BatchClientError) return { kind: error.kind, message: error.message };
  return { kind: "SERVICE", message: "LabelHunter could not complete this request. Try again." };
}

function rowWord(count: number): string {
  return count === 1 ? "row" : "rows";
}

interface BatchPreviewResultProps {
  result: BatchPreviewSuccessResponse;
  starting: boolean;
  startError: ErrorInfo | null;
  onStart: () => void;
}

/** Renders one accepted preview: the ready count, every reported pairing
 * problem (TH-R20 — reported, never silently dropped), and the "Start
 * batch" action. Kept inside this file, not split out: this preview view
 * has exactly one caller, unlike `ReviewQueueList.tsx`'s reused-elsewhere
 * shape. */
function BatchPreviewResult({ result, starting, startError, onStart }: BatchPreviewResultProps) {
  const hasProblems = result.unmatchedRows.length > 0 || result.unmatchedImages.length > 0 || result.invalidRows.length > 0;

  return (
    <div className="batch-preview" data-testid="batch-preview">
      <p className="status-banner" data-testid="batch-preview-summary">
        {result.readyCount} of {result.totalRows} {rowWord(result.totalRows)} ready to process.
      </p>

      {hasProblems && (
        <div className="batch-notice batch-notice--problems" data-testid="batch-preview-problems">
          <p className="batch-notice__title">Some rows or images were not matched. Fix them, or continue with the rest.</p>

          {result.invalidRows.length > 0 && (
            <>
              <p className="batch-notice__group-title">These rows have a problem:</p>
              <ul>
                {result.invalidRows.map((row) => (
                  <li key={`invalid-${row.rowNumber}`}>
                    Row {row.rowNumber}: {row.message}
                  </li>
                ))}
              </ul>
            </>
          )}

          {result.unmatchedRows.length > 0 && (
            <>
              <p className="batch-notice__group-title">These rows have no matching image:</p>
              <ul>
                {result.unmatchedRows.map((unmatched) => (
                  <li key={`unmatched-row-${unmatched.row.rowNumber}`}>
                    Row {unmatched.row.rowNumber} ({unmatched.row.brandName}): {unmatched.reason}
                  </li>
                ))}
              </ul>
            </>
          )}

          {result.unmatchedImages.length > 0 && (
            <>
              <p className="batch-notice__group-title">These images have no matching row:</p>
              <ul>
                {result.unmatchedImages.map((unmatched) => (
                  <li key={`unmatched-image-${unmatched.image.filename}`}>
                    {unmatched.image.filename}: {unmatched.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {result.readyCount > 0 ? (
        <>
          <button type="button" className="primary-button" disabled={starting} onClick={onStart}>
            {starting ? "Starting the batch…" : `Start batch (${result.readyCount})`}
          </button>
          {startError && (
            <div className="error-panel" role="alert">
              {/* Same lookup the preview-error panel below uses, not a
                  hardcoded title: a RATE_LIMITED or BUDGET_EXHAUSTED
                  failure carries a specific, plain-language reason
                  (PRD §8's key-protection guard), and which button the
                  reviewer pressed to reach it must not change whether
                  they get to see it. */}
              <p className="error-panel__title">{PREVIEW_ERROR_TITLE[startError.kind] ?? "Could not start this batch"}</p>
              <p className="error-panel__message">{startError.message}</p>
            </div>
          )}
        </>
      ) : (
        <p className="status-banner">Fix the problems above, then upload again.</p>
      )}
    </div>
  );
}

export function BatchUploadForm({ submitPreview = submitBatchPreview, submitStart = startBatch, onStarted }: BatchUploadFormProps) {
  const manifestInputRef = useRef<HTMLInputElement>(null);
  const imagesInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const [formError, setFormError] = useState<string | null>(null);

  function readFormData(): FormData | null {
    const manifest = manifestInputRef.current?.files?.[0];
    if (!manifest || manifest.size === 0) {
      setFormError("Add a CSV manifest file before you preview.");
      return null;
    }
    const images = Array.from(imagesInputRef.current?.files ?? []);
    const zip = zipInputRef.current?.files?.[0];
    if (images.length === 0 && (!zip || zip.size === 0)) {
      setFormError("Add label images before you preview. Choose files one at a time, or upload one zip file.");
      return null;
    }
    setFormError(null);

    const formData = new FormData();
    formData.set("manifest", manifest);
    for (const image of images) formData.append("images", image);
    if (zip && zip.size > 0) formData.set("imagesZip", zip);
    return formData;
  }

  async function runPreview() {
    const formData = readFormData();
    if (!formData) return;
    setPhase({ status: "previewing" });
    try {
      const result = await submitPreview(formData);
      setPhase({ status: "preview", result, starting: false, startError: null });
    } catch (error) {
      const { kind, message } = errorInfo(error);
      setPhase({ status: "preview-error", kind, message });
    }
  }

  async function runStart() {
    const formData = readFormData();
    if (!formData) return;
    setPhase((current) => (current.status === "preview" ? { ...current, starting: true, startError: null } : current));
    try {
      const result = await submitStart(formData);
      setPhase({ status: "started", result });
    } catch (error) {
      const info = errorInfo(error);
      setPhase((current) => (current.status === "preview" ? { ...current, starting: false, startError: info } : current));
    }
  }

  function handlePreviewSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runPreview();
  }

  /**
   * Changing any file input after a preview is on screen must not leave a
   * STALE preview (its ready count, its unmatched/invalid lists) sitting
   * above a "Start batch" button that would actually submit a DIFFERENT,
   * never-previewed upload (CodeRabbit finding, local review round 1) —
   * "Start batch" re-reads whatever the inputs hold at click time, so a
   * changed selection with an unrefreshed preview on screen would silently
   * start something the user never actually saw previewed. Resetting back
   * to "idle" here forces a fresh preview before "Start batch" can appear
   * again.
   */
  function handleFileInputChange() {
    setFormError(null);
    setPhase((current) => (current.status === "idle" ? current : { status: "idle" }));
  }

  if (phase.status === "started") {
    const { result } = phase;
    return (
      <div className="batch-started" data-testid="batch-started">
        <p className="status-banner">
          {result.queuedCount} {result.queuedCount === 1 ? "label is" : "labels are"} now processing.
        </p>
        {result.skippedImages.length > 0 && (
          <div className="batch-notice" data-testid="batch-skipped-images">
            <p className="batch-notice__title">
              {result.skippedImages.length} image{result.skippedImages.length === 1 ? "" : "s"} could not be read. LabelHunter did not
              include {result.skippedImages.length === 1 ? "it" : "them"}:
            </p>
            <ul>
              {result.skippedImages.map((skipped) => (
                <li key={skipped.filename}>
                  {skipped.filename}: {skipped.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <button type="button" className="primary-button" onClick={() => onStarted(result.batchJobId)}>
          View batch progress
        </button>
      </div>
    );
  }

  const isBusy = phase.status === "previewing" || (phase.status === "preview" && phase.starting);

  return (
    <>
      <form className="batch-upload-form" onSubmit={handlePreviewSubmit}>
        <div className="field">
          <label className="field__label" htmlFor="batch-manifest">
            CSV manifest
          </label>
          <input
            ref={manifestInputRef}
            id="batch-manifest"
            name="manifest"
            type="file"
            accept=".csv,text/csv"
            className="file-input"
            disabled={isBusy}
            onChange={handleFileInputChange}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="batch-images">
            Label images
          </label>
          <span className="field__hint" id="batch-images-hint">
            Select every image file, or use the zip option below.
          </span>
          <input
            ref={imagesInputRef}
            id="batch-images"
            name="images"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            multiple
            aria-describedby="batch-images-hint"
            className="file-input"
            disabled={isBusy}
            onChange={handleFileInputChange}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="batch-zip">
            Or a zip file of images
          </label>
          <input
            ref={zipInputRef}
            id="batch-zip"
            name="imagesZip"
            type="file"
            accept=".zip,application/zip"
            className="file-input"
            disabled={isBusy}
            onChange={handleFileInputChange}
          />
        </div>

        <button type="submit" className="primary-button" disabled={isBusy}>
          {phase.status === "previewing" ? "Checking the upload…" : "Preview batch"}
        </button>
      </form>

      {formError && (
        <div className="error-panel" role="alert">
          <p className="error-panel__title">Check your upload</p>
          <p className="error-panel__message">{formError}</p>
        </div>
      )}

      {phase.status === "preview-error" && (
        <div className="error-panel" role="alert">
          <p className="error-panel__title">{PREVIEW_ERROR_TITLE[phase.kind] ?? "Something went wrong"}</p>
          <p className="error-panel__message">{phase.message}</p>
        </div>
      )}

      {phase.status === "preview" && (
        <BatchPreviewResult result={phase.result} starting={phase.starting} startError={phase.startError} onStart={() => void runStart()} />
      )}
    </>
  );
}
