/**
 * Boundary validation for `POST /api/batch/preview`'s multipart form
 * (TRO-473 / LH-040, standing rule 13 — "validate at the boundary… name
 * the invariant, check explicitly"). Mirrors
 * `src/app/api/verify/parse-request.ts`'s own shape: this is the one
 * place an untrusted `FormData` becomes a typed, trustworthy
 * `ParsedBatchPreviewInput`, or a specific, human-readable rejection
 * (TH-R20). It does not touch the network, the filesystem, the database,
 * or CSV/zip content — that starts one layer up, in `route.ts` — so it is
 * trivial to unit test.
 */
import { MAX_IMAGE_COUNT, MAX_MANIFEST_BYTES } from "../../../../server/batch/constants";

export interface ParsedBatchPreviewInput {
  manifest: File;
  /** Individual multi-file-drop entries. Empty when the caller only sent
   * a zip. May be non-empty even alongside `imagesZip` — both sources are
   * accepted and merged (`route.ts`), not an either/or choice. */
  imageFiles: File[];
  /** `null` when no zip was sent, or the field was present but empty. */
  imagesZip: File | null;
}

export type ParseBatchPreviewResult = { ok: true; value: ParsedBatchPreviewInput } | { ok: false; message: string };

export function parseBatchPreviewFormData(formData: FormData): ParseBatchPreviewResult {
  const manifestEntry = formData.get("manifest");
  if (!(manifestEntry instanceof File) || manifestEntry.size === 0) {
    return { ok: false, message: "Add a CSV manifest file before you upload." };
  }
  if (manifestEntry.size > MAX_MANIFEST_BYTES) {
    const limitMb = (MAX_MANIFEST_BYTES / (1024 * 1024)).toFixed(1);
    return { ok: false, message: `This manifest file is too large. The limit is ${limitMb} MB.` };
  }

  const imageFiles = formData.getAll("images").filter((entry): entry is File => entry instanceof File);

  const zipEntry = formData.get("imagesZip");
  const imagesZip = zipEntry instanceof File && zipEntry.size > 0 ? zipEntry : null;

  if (imageFiles.length === 0 && !imagesZip) {
    return { ok: false, message: "Add label images before you upload — a zip file or individual image files." };
  }

  if (imageFiles.length > MAX_IMAGE_COUNT) {
    return {
      ok: false,
      message: `This batch has too many image files (${imageFiles.length}). The limit is ${MAX_IMAGE_COUNT}. Split it into smaller batches.`,
    };
  }

  return { ok: true, value: { manifest: manifestEntry, imageFiles, imagesZip } };
}
