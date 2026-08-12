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
import { MAX_IMAGE_COUNT, MAX_MANIFEST_BYTES, MAX_ZIP_ARCHIVE_BYTES } from "../../../../server/batch/constants";

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

/** Overridable ceilings, mirroring `zip.ts`'s own `ExtractZipLimits`
 * pattern — a test can prove a rejection cheaply, against a tiny fixture
 * and a tiny pretend ceiling, instead of allocating a real multi-hundred-
 * megabyte buffer just to cross the real one. */
export interface ParseBatchPreviewLimits {
  maxManifestBytes?: number;
  maxImageCount?: number;
  maxZipArchiveBytes?: number;
}

export function parseBatchPreviewFormData(
  formData: FormData,
  limits: ParseBatchPreviewLimits = {},
): ParseBatchPreviewResult {
  const maxManifestBytes = limits.maxManifestBytes ?? MAX_MANIFEST_BYTES;
  const maxImageCount = limits.maxImageCount ?? MAX_IMAGE_COUNT;
  const maxZipArchiveBytes = limits.maxZipArchiveBytes ?? MAX_ZIP_ARCHIVE_BYTES;

  const manifestEntry = formData.get("manifest");
  if (!(manifestEntry instanceof File) || manifestEntry.size === 0) {
    return { ok: false, message: "Add a CSV manifest file before you upload." };
  }
  if (manifestEntry.size > maxManifestBytes) {
    const limitMb = (maxManifestBytes / (1024 * 1024)).toFixed(1);
    return { ok: false, message: `This manifest file is too large. The limit is ${limitMb} MB.` };
  }

  const imageFiles = formData.getAll("images").filter((entry): entry is File => entry instanceof File);

  const zipEntry = formData.get("imagesZip");
  const imagesZip = zipEntry instanceof File && zipEntry.size > 0 ? zipEntry : null;

  // Checked before anything reads a single byte of the archive (review
  // finding) — the same "reject cheaply, before doing real work" shape
  // `manifestEntry.size` above already uses, and `zip.ts`'s own
  // `MAX_ZIP_UNCOMPRESSED_BYTES` uses one layer further in, once the
  // archive is actually opened.
  if (imagesZip && imagesZip.size > maxZipArchiveBytes) {
    const limitMb = (maxZipArchiveBytes / (1024 * 1024)).toFixed(0);
    return { ok: false, message: `This zip file is too large. The limit is ${limitMb} MB. Split it into smaller batches.` };
  }

  if (imageFiles.length === 0 && !imagesZip) {
    return { ok: false, message: "Add label images before you upload — a zip file or individual image files." };
  }

  if (imageFiles.length > maxImageCount) {
    return {
      ok: false,
      message: `This batch has too many image files (${imageFiles.length}). The limit is ${maxImageCount}. Split it into smaller batches.`,
    };
  }

  return { ok: true, value: { manifest: manifestEntry, imageFiles, imagesZip } };
}
