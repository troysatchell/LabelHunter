/**
 * Reads filenames and sizes from an uploaded zip of label images (PRD
 * §3.5). It returns a flat `{ filename, sizeBytes }` list and never needs
 * one decompressed image byte to do it.
 *
 * Every stored path is reduced to its basename first. A CSV manifest's
 * `image_filename` cell is always a plain filename, so a basename is what
 * pairing can match — and this module never touches a real filesystem
 * path, which closes off zip-slip before it can become a concern.
 * `zip.test.ts` proves that against a crafted `../../../etc/evil.jpg`
 * entry.
 *
 * **No entry is ever decompressed.** `accept()` is fflate's filter
 * callback: fflate calls it with each entry's central-directory metadata
 * before inflating anything. This module reads the name and declared size
 * from that metadata and always returns `false`, so `unzipSync` always
 * returns `{}`.
 *
 * A zip's declared size is attacker-controlled, and nothing here treats it
 * as fact. It feeds only this module's own bookkeeping — the returned
 * `sizeBytes` and the running total against `maxTotalBytes`. Whoever reads
 * the real bytes later must check them against its own limits; this module
 * promises only the filename and size preview.
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
  const images: BatchImageRef[] = [];

  function accept(file: UnzipFileInfo): boolean {
    if (rejectedMessage) return false;

    // Checked BEFORE the entry-count budget: a directory entry is not an
    // image, so it must never consume any of that budget — a zip
    // organized into a handful of subfolders should not lose count
    // headroom to the folders themselves (review finding).
    if (file.name.endsWith("/")) return false;

    entryCount += 1;
    if (entryCount > maxEntries) {
      rejectedMessage = `This zip file has too many entries. The limit is ${maxEntries}. Split it into smaller batches.`;
      return false;
    }

    totalBytes += file.originalSize;
    if (totalBytes > maxTotalBytes) {
      rejectedMessage = `This zip file is too large once opened (over ${megabytes(maxTotalBytes)} MB). Split it into smaller batches.`;
      return false;
    }

    // This is the only place this module ever sees this entry — capture
    // what it needs now. Returning `false` unconditionally, below, means
    // fflate never inflates this entry's real bytes regardless of this
    // decision; nothing about accepting it here costs any decompression.
    const filename = basename(file.name).normalize("NFC");
    if (filename !== "") {
      images.push({ filename, sizeBytes: file.originalSize });
    }
    return false;
  }

  try {
    unzipSync(data, { filter: accept });
  } catch {
    return { ok: false, message: "LabelHunter could not open this zip file. It may be damaged. Check the file and try again." };
  }

  if (rejectedMessage) {
    return { ok: false, message: rejectedMessage };
  }

  return { ok: true, images };
}
