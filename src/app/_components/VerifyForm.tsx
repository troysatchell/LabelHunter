"use client";

/**
 * The Verify screen's one form (TRO-465, PRD §5, TH-R1, TH-R3).
 *
 * One obvious primary flow: upload a photo, fill in the five application
 * fields plus the beverage-type selector, press the one "Verify" button.
 * Results render as a checklist below (`ResultsChecklist`); every failure
 * mode gets its own on-page panel (`ErrorPanel`, TH-R20) — never a toast.
 *
 * Uncontrolled inputs, read via `FormData` on submit: a file input cannot
 * be a controlled React value at all, and reading every field the same way
 * (through `FormData`, exactly like the server route reads the request)
 * keeps this component's own state to one thing — which phase it is in.
 */
import { useRef, useState, type FormEvent } from "react";
import type { BeverageType } from "../../lib/db/enums";
import { submitVerification, VerifyClientError, type VerifyFormValues } from "../_lib/verify-client";
import { BEVERAGE_TYPE_OPTIONS, NET_CONTENTS_UNIT_OPTIONS, type VerifyErrorKind, type VerifySuccessResponse } from "../api/verify/types";
import { ErrorPanel } from "./ErrorPanel";
import { ResultsChecklist } from "./ResultsChecklist";

type Phase =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: VerifySuccessResponse }
  | { status: "error"; kind: VerifyErrorKind; message: string };

export interface VerifyFormProps {
  /** Injected in tests; defaults to the real network call. */
  submit?: (values: VerifyFormValues) => Promise<VerifySuccessResponse>;
}

export function VerifyForm({ submit = submitVerification }: VerifyFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ status: "idle" });

  async function runSubmit() {
    const form = formRef.current;
    if (!form) return;

    // Read straight off the input's own `.files`, not `new FormData(form).get("image")`
    // — some DOM implementations rebuild a form-derived FormData's file
    // entries in a way that loses the underlying bytes (observed: a File
    // with the right name but `size: 0`). Reading the input directly is
    // also simply more direct: it is the one control that actually holds
    // this value.
    const imageFile = fileInputRef.current?.files?.[0];
    if (!imageFile || imageFile.size === 0) {
      setPhase({ status: "error", kind: "VALIDATION", message: "Add a label photo before you verify." });
      return;
    }

    const formData = new FormData(form);
    const values: VerifyFormValues = {
      imageFile,
      beverageType: String(formData.get("beverageType") ?? "") as BeverageType,
      brandName: String(formData.get("brandName") ?? ""),
      classType: String(formData.get("classType") ?? ""),
      alcoholContentPercent: String(formData.get("alcoholContentPercent") ?? ""),
      netContentsValue: String(formData.get("netContentsValue") ?? ""),
      netContentsUnit: String(formData.get("netContentsUnit") ?? ""),
    };

    setPhase({ status: "loading" });
    try {
      const result = await submit(values);
      setPhase({ status: "success", result });
    } catch (error) {
      if (error instanceof VerifyClientError) {
        setPhase({ status: "error", kind: error.kind, message: error.message });
      } else {
        setPhase({ status: "error", kind: "SERVICE", message: "LabelHunter could not complete this request. Try again." });
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSubmit();
  }

  const isLoading = phase.status === "loading";

  return (
    <>
      <form ref={formRef} className="verify-form" onSubmit={handleSubmit}>
        <div className="field">
          <label className="field__label" htmlFor="verify-image">
            Label photo
          </label>
          {/* No `required` here on purpose: this component's own check in
              `runSubmit` below already catches a missing photo and shows a
              specific, plain-language panel ("Add a label photo before you
              verify.") — a clearer message for a first-time user (TH-R3)
              than a browser's terse native file-input validation tooltip,
              which also varies by browser. */}
          <input
            ref={fileInputRef}
            id="verify-image"
            name="image"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            className="file-input"
            disabled={isLoading}
          />
        </div>

        <fieldset className="field">
          <legend>Beverage type</legend>
          <div className="beverage-options">
            {BEVERAGE_TYPE_OPTIONS.map((option, index) => (
              <label key={option.value}>
                <input type="radio" name="beverageType" value={option.value} defaultChecked={index === 0} required disabled={isLoading} />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label className="field__label" htmlFor="verify-brand-name">
            Brand name
          </label>
          <input id="verify-brand-name" name="brandName" type="text" required className="field__input" disabled={isLoading} />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="verify-class-type">
            Class/type
          </label>
          <input id="verify-class-type" name="classType" type="text" required className="field__input" disabled={isLoading} />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="verify-abv">
            Alcohol content (% ABV)
          </label>
          <span className="field__hint" id="verify-abv-hint">
            Leave blank if the label has none.
          </span>
          <input
            id="verify-abv"
            name="alcoholContentPercent"
            type="number"
            min={0}
            max={100}
            step="any"
            inputMode="decimal"
            aria-describedby="verify-abv-hint"
            className="field__input"
            disabled={isLoading}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label className="field__label" htmlFor="verify-net-contents-value">
              Net contents
            </label>
            <input
              id="verify-net-contents-value"
              name="netContentsValue"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              required
              className="field__input"
              disabled={isLoading}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="verify-net-contents-unit">
              Unit
            </label>
            <select
              id="verify-net-contents-unit"
              name="netContentsUnit"
              required
              className="field__select"
              disabled={isLoading}
              defaultValue={NET_CONTENTS_UNIT_OPTIONS[0]}
            >
              {NET_CONTENTS_UNIT_OPTIONS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button type="submit" className="primary-button" disabled={isLoading}>
          {isLoading ? "Checking the label…" : "Verify"}
        </button>
      </form>

      <div aria-live="polite">{isLoading && <p className="status-banner">Checking the label…</p>}</div>

      {phase.status === "error" && <ErrorPanel kind={phase.kind} message={phase.message} onRetry={() => void runSubmit()} />}

      {phase.status === "success" && <ResultsChecklist result={phase.result} />}
    </>
  );
}
