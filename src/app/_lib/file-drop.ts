/**
 * Drag-and-drop file helpers (UI pass, Troy direct).
 *
 * Pure DOM helpers, no React. The dropzone (`FileDropField.tsx`) assigns
 * dropped files to the SAME native input the label points at, then fires
 * one real bubbling `change` event. React's delegated `onChange` rides the
 * native event, so every existing handler — `VerifyForm`'s autofill
 * assist, `BatchUploadForm`'s stale-preview reset — runs unmodified,
 * exactly as if the user had used the file picker.
 */

/**
 * True when `file` satisfies one entry of an input's `accept` list.
 *
 * Two entry shapes cover this app's file inputs:
 * - A MIME type ("image/png", "text/csv") matches `file.type` exactly.
 * - An extension (".csv", ".zip") matches the end of `file.name`.
 *
 * The extension form is load-bearing, not a nicety: an OS drag often
 * hands over a `.csv` file with an EMPTY MIME type, which no MIME entry
 * can match. An empty accept list accepts every file.
 */
export function acceptsFile(file: File, accept: string): boolean {
  const entries = accept
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return true;

  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return entries.some((entry) => (entry.startsWith(".") ? name.endsWith(entry) : entry === type));
}

/**
 * Filters `dropped` against `input.accept`, assigns the accepted files to
 * `input`, and fires one bubbling `change` event — the same event the
 * input's own picker fires. Returns how many files it assigned.
 *
 * A drop with zero accepted files returns 0 and touches NOTHING — a bad
 * drop must never clear an existing valid selection.
 *
 * A single-file input takes only the FIRST accepted file, matching what
 * its own picker allows. `accept` and `multiple` are read off the input
 * itself, so this helper can never disagree with the control it fills.
 */
export function assignDroppedFiles(input: HTMLInputElement, dropped: FileList | readonly File[]): number {
  const accepted = Array.from(dropped).filter((file) => acceptsFile(file, input.accept));
  if (accepted.length === 0) return 0;

  const chosen = input.multiple ? accepted : accepted.slice(0, 1);
  const dataTransfer = new DataTransfer();
  for (const file of chosen) dataTransfer.items.add(file);
  input.files = dataTransfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return chosen.length;
}
