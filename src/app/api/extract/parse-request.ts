/**
 * Boundary validation for the extract route's multipart form (TRO-576,
 * standing rule 13). The endpoint takes exactly one thing: the label
 * photo. Same posture as `../verify/parse-request.ts` — untrusted input
 * in, a typed value or a plain-language rejection out, no I/O, trivially
 * unit-testable.
 */

export type ParseExtractFormDataResult = { ok: true; imageFile: File } | { ok: false; message: string };

export function parseExtractFormData(formData: FormData): ParseExtractFormDataResult {
  const imageEntry = formData.get("image");
  if (!(imageEntry instanceof File) || imageEntry.size === 0) {
    return { ok: false, message: "Add a label photo first." };
  }
  return { ok: true, imageFile: imageEntry };
}
