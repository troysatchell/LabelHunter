"use client";

/**
 * A drag-and-drop wrapper around a NATIVE file input (UI pass, Troy
 * direct). Progressive enhancement only: the input keeps its id, label,
 * and keyboard path — the e2e suite drives the input, not this div. A
 * drop assigns the accepted files to that same input and fires a real
 * bubbling `change` event (`assignDroppedFiles`), so every existing
 * onChange handler runs unmodified.
 *
 * Deliberately NO role and NO button semantics on the div: the native
 * input inside stays the one accessible control, so assistive tech sees
 * exactly the control it saw before this wrapper existed. Feedback for an
 * ACCEPTED drop flows through whatever live region the caller already
 * owns (e.g. `VerifyForm`'s assist line), because the input's `change`
 * event runs the caller's own handler.
 *
 * A fully REJECTED drop is the one case the caller cannot see: no file is
 * assigned, so no `change` event fires and no caller handler runs. That
 * silence is a dead end — drop a PDF on the photo field and nothing at
 * all happens. `onRejected` closes it, and the caller writes the message
 * into the live region it already owns. This component adds no region of
 * its own: both callers already have exactly one, and a second region in
 * the same form is what makes one event announce twice.
 *
 * The hint span gets `id={hintId}` so the caller can tie it to the input
 * with `aria-describedby` — the affordance is described on the control,
 * not on a div a screen reader would never land on.
 */
import { useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { assignDroppedFiles } from "../_lib/file-drop";

export interface FileDropFieldProps {
  /** The native file input rendered inside `children`. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Mirrors the input's own disabled state — a drop on a disabled
   * control must do nothing. */
  disabled?: boolean;
  /** One short STE sentence, e.g. "Or drop the photo here." */
  hint: string;
  /** The hint span's id, for the caller's `aria-describedby`. */
  hintId: string;
  /** Called when a drop carries nothing this input accepts. The caller
   * says so in its own live region — see this file's header comment. */
  onRejected?: () => void;
  children: ReactNode;
}

/** True when the drag carries files — a text selection or a dragged link
 * must not light the dropzone up or have its browser default suppressed. */
function dragHasFiles(event: DragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function FileDropField({ inputRef, disabled = false, hint, hintId, onRejected, children }: FileDropFieldProps) {
  const [isActive, setActive] = useState(false);

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    // Without preventDefault the browser refuses the drop and then
    // navigates to the dropped file.
    event.preventDefault();
    if (!disabled) setActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    // Moving over a child fires dragleave on this div too — only clear
    // the highlight when the pointer really left the zone.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    setActive(false);
    if (disabled) return;
    const input = inputRef.current;
    if (!input) return;
    // Zero accepted files leaves any existing valid selection alone (see
    // file-drop.ts) — and fires no `change` event, so the caller hears
    // nothing unless this tells it.
    if (assignDroppedFiles(input, event.dataTransfer.files) === 0) onRejected?.();
  }

  return (
    <div
      className={isActive ? "file-drop file-drop--active" : "file-drop"}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      <span className="field__hint" id={hintId}>
        {hint}
      </span>
    </div>
  );
}
