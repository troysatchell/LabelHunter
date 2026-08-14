"use client";

/**
 * The Verify screen's one form (TRO-465, PRD §5, TH-R1, TH-R3).
 *
 * One obvious primary flow: upload a photo, confirm the five application
 * fields, press the one "Verify" button. Results render as a checklist
 * below (`ResultsChecklist`); every failure mode gets its own on-page
 * panel (`ErrorPanel`, TH-R20) — never a toast.
 *
 * Auto-fill assist (TRO-576): picking a photo sends it to
 * `POST /api/extract`, and whatever the label already says fills the
 * matching fields — Sarah's "data entry verification" pain point,
 * removed. Three rules keep the assist honest:
 * 1. The agent's own typing always wins. A field the agent touched is
 *    never overwritten, and marking is by real interaction — not by
 *    whether the field looks empty.
 * 2. Every filled value says so ("Read from your photo") until the agent
 *    edits it. The agent, not the assist, asserts the application data
 *    that `/api/verify` compares against.
 * 3. The assist never blocks. Any failure quiets down to one plain
 *    sentence and the manual flow continues untouched.
 *
 * Uncontrolled inputs, read via `FormData` on submit: a file input cannot
 * be a controlled React value at all, and reading every field the same way
 * (through `FormData`, exactly like the server route reads the request)
 * keeps this component's own state small. The assist SETS input values
 * imperatively through the form element for the same reason — a
 * programmatic `.value` write does not fire events, so it cannot be
 * mistaken for the agent's own edit.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BeverageType } from "../../lib/db/enums";
import { requestExtraction } from "../_lib/extract-client";
import { submitVerification, VerifyClientError, type VerifyFormValues } from "../_lib/verify-client";
import type { ExtractSuccessResponse } from "../api/extract/types";
import { BEVERAGE_TYPE_OPTIONS, NET_CONTENTS_UNIT_OPTIONS, type VerifyErrorKind, type VerifySuccessResponse } from "../api/verify/types";
import { ErrorPanel } from "./ErrorPanel";
import { FileDropField } from "./FileDropField";
import { ResultsChecklist } from "./ResultsChecklist";

type Phase =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: VerifySuccessResponse }
  | { status: "error"; kind: VerifyErrorKind; message: string };

/** The assist's own tiny lifecycle. "note" covers every settled outcome —
 * filled, unreadable, failed — because each is one sentence the agent
 * reads and moves past. */
type Assist = { status: "idle" } | { status: "reading" } | { status: "note"; message: string };

/** The form controls the assist can fill. `netContents` covers the
 * value + unit pair — they are one reading ("750 mL"), so they carry one
 * provenance note. */
type PrefillKey = "beverageType" | "brandName" | "classType" | "alcoholContentPercent" | "netContents";

export const ASSIST_FAILED_MESSAGE = "LabelHunter could not read the label just now. Fill in the fields yourself.";
export const ASSIST_NOTHING_READ_MESSAGE = "LabelHunter could not read any fields from this photo. Fill them in yourself.";

export interface VerifyFormProps {
  /** Injected in tests; defaults to the real network call. */
  submit?: (values: VerifyFormValues) => Promise<VerifySuccessResponse>;
  /** Injected in tests; defaults to the real extract-assist call. */
  extract?: (imageFile: File) => Promise<ExtractSuccessResponse>;
}

export function VerifyForm({ submit = submitVerification, extract = requestExtraction }: VerifyFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const [assist, setAssist] = useState<Assist>({ status: "idle" });
  /** Fields whose CURRENT value came from the photo and has not been
   * edited since — these show the provenance note and stay refillable
   * when the agent picks a different photo. */
  const [photoFilled, setPhotoFilled] = useState<ReadonlySet<PrefillKey>>(new Set());
  /** Fields the agent actually interacted with. Their values are the
   * agent's own and are never overwritten by the assist. */
  const touchedRef = useRef<Set<PrefillKey>>(new Set());
  /** Guards a slow extraction against a newer file selection: only the
   * latest request's result may touch the form. */
  const extractSeqRef = useRef(0);
  /** Read inside the extract callback below, where the closed-over
   * `phase` would be stale — the same ref-mirror pattern
   * `BatchProgressBrowser` uses for its poll. Written from an effect, not
   * during render (React's `react-hooks/refs` rule). */
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  function markTouched(key: PrefillKey) {
    touchedRef.current.add(key);
    setPhotoFilled((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  /** Writes one control's value through the form element. Returns whether
   * the write happened — the caller counts what it filled. */
  function setControlValue(name: string, value: string): boolean {
    const form = formRef.current;
    if (!form) return false;
    const control = form.elements.namedItem(name);
    // RadioNodeList (the beverage radios) and single inputs/selects both
    // expose a writable `value`; setting a RadioNodeList's value checks
    // the matching radio. The structural cast covers both — they share no
    // common DOM interface beyond this property.
    if (control && "value" in control) {
      (control as { value: string }).value = value;
      return true;
    }
    return false;
  }

  function applyPrefill(response: ExtractSuccessResponse) {
    if (response.outcome === "unreadable") {
      setAssist({ status: "note", message: response.message ?? ASSIST_NOTHING_READ_MESSAGE });
      return;
    }

    const { fields } = response;
    const filled = new Set<PrefillKey>();
    const touched = touchedRef.current;

    if (fields.beverageType !== null && !touched.has("beverageType") && setControlValue("beverageType", fields.beverageType)) {
      filled.add("beverageType");
    }
    if (fields.brandName !== null && !touched.has("brandName") && setControlValue("brandName", fields.brandName)) {
      filled.add("brandName");
    }
    if (fields.classType !== null && !touched.has("classType") && setControlValue("classType", fields.classType)) {
      filled.add("classType");
    }
    if (
      fields.alcoholContentPercent !== null &&
      !touched.has("alcoholContentPercent") &&
      setControlValue("alcoholContentPercent", String(fields.alcoholContentPercent))
    ) {
      filled.add("alcoholContentPercent");
    }
    if (fields.netContentsValue !== null && fields.netContentsUnit !== null && !touched.has("netContents")) {
      const valueSet = setControlValue("netContentsValue", String(fields.netContentsValue));
      const unitSet = setControlValue("netContentsUnit", fields.netContentsUnit);
      if (valueSet && unitSet) filled.add("netContents");
    }

    if (filled.size === 0) {
      setAssist({ status: "note", message: ASSIST_NOTHING_READ_MESSAGE });
      setPhotoFilled(new Set());
      return;
    }

    const noun = filled.size === 1 ? "field" : "fields";
    setAssist({
      status: "note",
      message: `LabelHunter filled ${filled.size} ${noun} from your photo. Check them, then press Verify.`,
    });
    setPhotoFilled(filled);
  }

  /** Returns a still-photo-owned field to its pristine state. Values from
   * a photo that is no longer selected must not linger — a partial or
   * unreadable second reading would otherwise leave the first photo's
   * values sitting in the form looking like the agent's own entries
   * (CodeRabbit finding, TRO-576 review round 1). */
  function clearPhotoValue(key: PrefillKey) {
    switch (key) {
      case "beverageType":
        setControlValue("beverageType", BEVERAGE_TYPE_OPTIONS[0].value);
        return;
      case "brandName":
        setControlValue("brandName", "");
        return;
      case "classType":
        setControlValue("classType", "");
        return;
      case "alcoholContentPercent":
        setControlValue("alcoholContentPercent", "");
        return;
      case "netContents":
        setControlValue("netContentsValue", "");
        setControlValue("netContentsUnit", NET_CONTENTS_UNIT_OPTIONS[0]);
        return;
    }
  }

  function handleFileSelected() {
    const imageFile = fileInputRef.current?.files?.[0];
    if (!imageFile || imageFile.size === 0) return;
    // Never touch the form while a verify is in flight — the assist
    // assists; it does not race the submission.
    if (phase.status === "loading") return;

    // The previous photo's values describe the previous photo. Clear
    // every field it filled (the agent's own entries stay) before the new
    // reading starts, so nothing stale can survive a partial or
    // unreadable second extraction.
    for (const key of photoFilled) {
      clearPhotoValue(key);
    }
    setPhotoFilled(new Set());

    const seq = ++extractSeqRef.current;
    setAssist({ status: "reading" });
    extract(imageFile).then(
      (response) => {
        if (seq !== extractSeqRef.current) return;
        // Through the ref, not the closed-over `phase`: a verify started
        // after this extraction began must not have its (disabled) form
        // rewritten underneath it by a late assist result.
        if (phaseRef.current.status === "loading") return;
        applyPrefill(response);
      },
      () => {
        if (seq !== extractSeqRef.current) return;
        setAssist({ status: "note", message: ASSIST_FAILED_MESSAGE });
      },
    );
  }

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

    // Build the FormData BEFORE `setPhase({ status: "loading" })` below, not
    // after: every control sets `disabled={isLoading}`, and a disabled
    // control is excluded from `new FormData(form)` entirely (the HTML
    // forms spec, not a React quirk) — reversing this order would silently
    // send blank values for every field.
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

    // One validation strategy for the whole form, not two: every required
    // field is checked here and reported through this component's own
    // ErrorPanel, the same way the photo check above already works. HTML
    // `required` is deliberately absent from every control (see the file
    // header note by the photo input) — a native browser tooltip fires
    // before `submit`, so it could preempt whichever one of these checks
    // would otherwise run first, and its wording is out of this app's
    // control. beverageType and netContentsUnit are not checked here: both
    // always carry a value from their own `defaultChecked`/`defaultValue`,
    // so they can never actually be empty.
    if (values.brandName.trim() === "") {
      setPhase({ status: "error", kind: "VALIDATION", message: "Add a brand name before you verify." });
      return;
    }
    if (values.classType.trim() === "") {
      setPhase({ status: "error", kind: "VALIDATION", message: "Add a class or type before you verify." });
      return;
    }
    if (values.netContentsValue.trim() === "") {
      setPhase({ status: "error", kind: "VALIDATION", message: "Add net contents before you verify." });
      return;
    }

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

  function prefillNote(key: PrefillKey) {
    if (!photoFilled.has(key)) return null;
    return <span className="field__prefill-note">Read from your photo</span>;
  }

  return (
    <>
      {/* aria-busy while the assist reads a photo: the assist is about to
          rewrite fields across the whole form, so the form itself is the
          region that is busy — not any one field. The assist's live
          announcer sits OUTSIDE this form (below), because aria-busy lets
          assistive tech withhold every change inside the busy region until
          it clears (WAI-ARIA) — a live region inside would risk announcing
          "Reading the label…" never, or only after it is gone. */}
      <form ref={formRef} className="verify-form" onSubmit={handleSubmit} aria-busy={assist.status === "reading"}>
        <div className="field">
          <label className="field__label" htmlFor="verify-image">
            Label photo
          </label>
          {/* No `required` here, or on any other control in this form: this
              component's own checks in `runSubmit` below catch every
              missing required value and show a specific, plain-language
              panel ("Add a label photo before you verify.", and so on) — a
              clearer message for a first-time user (TH-R3) than a
              browser's terse native validation tooltip, which also varies
              by browser and fires before `submit`, so it could silently
              preempt whichever of these checks would otherwise report
              first. One validation strategy for the whole form. */}
          {/* A drop assigns the file to this same input and fires a real
              change event, so `handleFileSelected` — autofill, stale-
              prefill clearing, the seq and phase guards — runs untouched
              (see FileDropField.tsx). Disabled with the input: a verify
              in flight must not gain a new photo by drop either. */}
          <FileDropField inputRef={fileInputRef} disabled={isLoading} hint="Or drop the photo here." hintId="verify-image-drop-hint">
            <input
              ref={fileInputRef}
              id="verify-image"
              name="image"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              className="file-input"
              disabled={isLoading}
              aria-describedby="verify-image-drop-hint"
              onChange={handleFileSelected}
            />
            {/* The assist's one VISIBLE status line. Deliberately not a
                live region: it sits inside the aria-busy form, where an
                announcement could be withheld until busy clears (WAI-ARIA).
                The hidden twin after the form does the announcing. The
                spinner is aria-hidden: the text carries the meaning. */}
            <span className="verify-form__assist" data-testid="verify-assist">
              {assist.status === "reading" && (
                <>
                  <span className="busy-spinner" aria-hidden="true" />
                  Reading the label…
                </>
              )}
              {assist.status === "note" && assist.message}
            </span>
          </FileDropField>
        </div>

        <fieldset className="field">
          <legend>Beverage type</legend>
          {prefillNote("beverageType")}
          <div className="beverage-options">
            {BEVERAGE_TYPE_OPTIONS.map((option, index) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name="beverageType"
                  value={option.value}
                  defaultChecked={index === 0}
                  disabled={isLoading}
                  onChange={() => markTouched("beverageType")}
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label className="field__label" htmlFor="verify-brand-name">
            Brand name
          </label>
          {prefillNote("brandName")}
          <input
            id="verify-brand-name"
            name="brandName"
            type="text"
            className="field__input"
            disabled={isLoading}
            onInput={() => markTouched("brandName")}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="verify-class-type">
            Class/type
          </label>
          {prefillNote("classType")}
          <input
            id="verify-class-type"
            name="classType"
            type="text"
            className="field__input"
            disabled={isLoading}
            onInput={() => markTouched("classType")}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="verify-abv">
            Alcohol content (% ABV)
          </label>
          {prefillNote("alcoholContentPercent")}
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
            onInput={() => markTouched("alcoholContentPercent")}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label className="field__label" htmlFor="verify-net-contents-value">
              Net contents
            </label>
            {prefillNote("netContents")}
            <input
              id="verify-net-contents-value"
              name="netContentsValue"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              className="field__input"
              disabled={isLoading}
              onInput={() => markTouched("netContents")}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="verify-net-contents-unit">
              Unit
            </label>
            <select
              id="verify-net-contents-unit"
              name="netContentsUnit"
              className="field__select"
              disabled={isLoading}
              defaultValue={NET_CONTENTS_UNIT_OPTIONS[0]}
              onChange={() => markTouched("netContents")}
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
          {isLoading ? (
            <>
              <span className="busy-spinner" aria-hidden="true" />
              Checking the label…
            </>
          ) : (
            "Verify"
          )}
        </button>
      </form>

      {/* The assist's announcer: a persistent polite line OUTSIDE the
          aria-busy form, mirroring the visible assist text above (the
          AccessCodeForm pattern). Inside the form, aria-busy could hold
          the announcement back until the reading is over — the one moment
          it matters (WAI-ARIA). Visually hidden: sighted users see the
          in-form line. */}
      <p className="visually-hidden" role="status">
        {assist.status === "reading" ? "Reading the label…" : assist.status === "note" ? assist.message : ""}
      </p>

      {/* One persistent aria-live region, present from this component's
          first render, not a new one mounted per phase — a live region only
          reliably announces content ADDED to it after it already exists in
          the DOM (WAI-ARIA), so the loading text and the results checklist
          both render inside this same div rather than each other mounting
          their own. `ErrorPanel` does not need this: `role="alert"` is its
          own live-region equivalent, specified to announce correctly even
          when the whole element is inserted at once. No aria-busy here,
          ever: this region IS the announcer for the multi-second Haiku
          call, and aria-busy lets assistive tech withhold changes inside a
          busy region until it clears (WAI-ARIA) — it would suppress the
          exact in-flight line it wraps. The aria-hidden skeleton reserves
          the checklist's space so the results land without a layout jump. */}
      <div aria-live="polite">
        {isLoading && (
          <>
            <p className="status-banner">
              <span className="busy-spinner" aria-hidden="true" />
              Checking the label…
            </p>
            <div className="skeleton-stack" aria-hidden="true" data-testid="verify-results-skeleton">
              <div className="skeleton-block skeleton-block--banner" />
              <div className="skeleton-block skeleton-block--row" />
              <div className="skeleton-block skeleton-block--row" />
              <div className="skeleton-block skeleton-block--row" />
              <div className="skeleton-block skeleton-block--row" />
              <div className="skeleton-block skeleton-block--row" />
            </div>
          </>
        )}
        {phase.status === "success" && <ResultsChecklist result={phase.result} />}
      </div>

      {phase.status === "error" && <ErrorPanel kind={phase.kind} message={phase.message} onRetry={() => void runSubmit()} />}
    </>
  );
}
