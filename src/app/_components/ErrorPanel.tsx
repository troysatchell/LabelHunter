/**
 * A designed error state (TH-R20) — an on-page panel, not a toast. Every
 * failure mode the verify route can report (`VerifyErrorKind`,
 * `src/app/api/verify/types.ts`) gets its own plain-English title here;
 * `message` is always the server's own human-readable text (preprocessing's
 * own error messages, `src/server/preprocessing/errors.ts`, or the honest
 * "could not read this label" line for an extraction failure). `role="alert"`
 * so assistive tech announces it without the user having to go looking.
 */
import type { VerifyErrorKind } from "../api/verify/types";

const ERROR_TITLE: Record<VerifyErrorKind, string> = {
  VALIDATION: "Check the form",
  IMAGE: "LabelHunter can't use this photo",
  EXTRACTION: "LabelHunter could not read this label",
  SERVICE: "Something went wrong",
};

export interface ErrorPanelProps {
  kind: VerifyErrorKind;
  message: string;
  onRetry: () => void;
}

export function ErrorPanel({ kind, message, onRetry }: ErrorPanelProps) {
  return (
    <div className="error-panel" role="alert">
      <p className="error-panel__title">{ERROR_TITLE[kind]}</p>
      <p className="error-panel__message">{message}</p>
      <button type="button" className="secondary-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
