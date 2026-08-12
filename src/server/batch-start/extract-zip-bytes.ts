/**
 * Extracts real image bytes for a bounded, pre-validated set of filenames
 * from an uploaded batch zip (LH-042 / TRO-475, PRD §3.5).
 *
 * `../batch/zip.ts`'s own `extractZipEntries` (LH-040) deliberately never
 * decompresses a single entry — by design, for the pairing-PREVIEW step,
 * which only ever needs a filename and a declared size (see that file's own
 * comment). Starting a batch is the first point real image bytes are
 * needed — nothing before this ticket ever decompressed one. This module is
 * that: given the exact filenames `buildBatchPreview` already matched to a
 * CSV row, decompress just those entries.
 *
 * Bounded, not a general unzip: only entries whose basename is in
 * `wantedFilenames` are ever inflated. Every one of those filenames already
 * passed `buildBatchPreview`'s own pairing/count checks
 * (`../batch/constants.ts`'s `MAX_IMAGE_COUNT`), so the number of entries
 * this module can ever decompress is capped there regardless of how many
 * OTHER entries the zip itself contains. `maxBytesPerImage` separately
 * bounds any ONE entry's real inflated size, checked against the bytes
 * fflate actually produces — not only the zip's own (attacker-controlled)
 * declared size, the same "don't trust the declared number alone" posture
 * `zip.ts`'s own file comment documents for its different, size-only check.
 */
import { unzipSync, type UnzipFileInfo } from "fflate";
import { MAX_UPLOAD_BYTES } from "../preprocessing";

export interface ExtractZipImageBytesLimits {
  /** Per-entry cap on real (inflated) bytes. Defaults to the same ceiling a
   * single-label upload is held to (`MAX_UPLOAD_BYTES`,
   * `../preprocessing/constants.ts`) — one label photo from a batch zip is
   * not held to a looser standard than one uploaded through the single-
   * verify form. */
  maxBytesPerImage?: number;
}

export type ExtractZipImageBytesResult =
  | { ok: true; images: Map<string, Uint8Array> }
  | { ok: false; message: string };

function basename(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

function megabytes(bytesCount: number): string {
  return (bytesCount / (1024 * 1024)).toFixed(0);
}

/**
 * `wantedFilenames` — basenames only, matching `zip.ts`'s own basename-only
 * pairing convention. A caller builds this set from a `buildBatchPreview`
 * result's own `matched` list (image filenames already proven, at the
 * preview step, to pair one-to-one with a CSV row and to be unambiguous
 * within this same zip) — never from unvalidated user input directly. Under
 * that precondition, two accepted entries can never legitimately share one
 * basename: `pairing.ts` already routes a filename two uploads share to
 * `unmatchedImages` as ambiguous, before it can ever reach `matched`. If a
 * caller violates that precondition, whichever entry fflate returns LAST
 * for a shared basename wins — this module does not re-detect the ambiguity
 * a second time.
 */
export function extractZipImageBytes(
  zipBytes: Uint8Array,
  wantedFilenames: ReadonlySet<string>,
  limits: ExtractZipImageBytesLimits = {},
): ExtractZipImageBytesResult {
  const maxBytesPerImage = limits.maxBytesPerImage ?? MAX_UPLOAD_BYTES;
  let rejectedMessage: string | null = null;

  function accept(file: UnzipFileInfo): boolean {
    if (rejectedMessage) return false;
    if (file.name.endsWith("/")) return false;

    const filename = basename(file.name).normalize("NFC");
    if (!wantedFilenames.has(filename)) return false;

    // Checked against the entry's own DECLARED size first — cheap, and
    // catches the common case before fflate inflates anything. The real
    // inflated size is re-checked below, after decompression, since a
    // declared size is attacker-controlled input (standing rule 18) that
    // fflate does not promise matches the real output.
    if (file.originalSize > maxBytesPerImage) {
      rejectedMessage = `The image "${filename}" is too large. The limit is ${megabytes(maxBytesPerImage)} MB per image.`;
      return false;
    }
    return true;
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes, { filter: accept });
  } catch {
    return { ok: false, message: "LabelHunter could not open this zip file. It may be damaged. Check the file and try again." };
  }
  if (rejectedMessage) {
    return { ok: false, message: rejectedMessage };
  }

  const images = new Map<string, Uint8Array>();
  for (const [entryPath, bytes] of Object.entries(unzipped)) {
    const filename = basename(entryPath).normalize("NFC");
    if (!wantedFilenames.has(filename)) continue; // defensive — accept() already filtered this
    if (bytes.byteLength > maxBytesPerImage) {
      return { ok: false, message: `The image "${filename}" is too large. The limit is ${megabytes(maxBytesPerImage)} MB per image.` };
    }
    images.set(filename, bytes);
  }

  return { ok: true, images };
}
