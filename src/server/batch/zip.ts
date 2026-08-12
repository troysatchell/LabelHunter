/**
 * Extracts filenames and sizes from an uploaded zip of label images
 * (TRO-473 / LH-040, PRD §3.5). `pairing.ts` only ever needs a flat list
 * of `{ filename, sizeBytes }` — this module's only job is turning zip
 * bytes into that list, safely.
 *
 * Every entry's stored path (e.g. "images/front/bottle-001.jpg") is
 * reduced to its basename before anything else sees it. Two reasons: a
 * CSV manifest's own `image_filename` cell is always a plain filename,
 * never a path, so a basename is what `pairing.ts` can actually match;
 * and an entry path is untrusted input (standing rule 18) this module
 * never uses to read or write a real filesystem path, which closes off
 * zip-slip (path traversal via `../..`) as a concern before it can become
 * one — there is no path to traverse into.
 *
 * Entry-count and total-size limits are enforced through fflate's own
 * `filter` option, which runs BEFORE an entry is decompressed. A crafted
 * zip that lies about being small in its directory listing still cannot
 * force a large real decompression — each entry's declared uncompressed
 * size is checked, and decompression of that entry is skipped, the
 * moment the running total would exceed the limit.
 */
import { unzipSync, type UnzipFileInfo } from "fflate";
import { MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED_BYTES } from "./constants";
import type { BatchImageRef } from "./types";

export type ExtractZipResult = { ok: true; images: BatchImageRef[] } | { ok: false; message: string };

export interface ExtractZipLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
}

function basename(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

function megabytes(bytesCount: number): string {
  return (bytesCount / (1024 * 1024)).toFixed(0);
}

export function extractZipEntries(data: Uint8Array, limits: ExtractZipLimits = {}): ExtractZipResult {
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;

  let entryCount = 0;
  let totalBytes = 0;
  let rejectedMessage: string | null = null;

  function accept(file: UnzipFileInfo): boolean {
    if (rejectedMessage) return false;

    entryCount += 1;
    if (entryCount > maxEntries) {
      rejectedMessage = `This zip file has too many entries. The limit is ${maxEntries}. Split it into smaller batches.`;
      return false;
    }

    if (file.name.endsWith("/")) return false; // a directory entry, not an image

    totalBytes += file.originalSize;
    if (totalBytes > maxTotalBytes) {
      rejectedMessage = `This zip file is too large once opened (over ${megabytes(maxTotalBytes)} MB). Split it into smaller batches.`;
      return false;
    }

    return true;
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, { filter: accept });
  } catch {
    return { ok: false, message: "LabelHunter could not open this zip file. It may be damaged. Check the file and try again." };
  }

  if (rejectedMessage) {
    return { ok: false, message: rejectedMessage };
  }

  const images: BatchImageRef[] = [];
  for (const [entryPath, fileBytes] of Object.entries(entries)) {
    const filename = basename(entryPath).normalize("NFC");
    if (filename === "") continue; // defensive — accept() already excludes "/"-suffixed entries
    images.push({ filename, sizeBytes: fileBytes.length });
  }

  return { ok: true, images };
}
