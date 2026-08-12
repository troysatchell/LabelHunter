/**
 * Extracts filenames and sizes from an uploaded zip of label images
 * (TRO-473 / LH-040, PRD §3.5). `pairing.ts` only ever needs a flat list
 * of `{ filename, sizeBytes }` — this module's only job is turning zip
 * bytes into that list, safely, and it never needs a single decompressed
 * image byte to do it.
 *
 * Every entry's stored path (e.g. "images/front/bottle-001.jpg") is
 * reduced to its basename before anything else sees it. Two reasons: a
 * CSV manifest's own `image_filename` cell is always a plain filename,
 * never a path, so a basename is what `pairing.ts` can actually match;
 * and an entry path is untrusted input (standing rule 18) this module
 * never uses to read or write a real filesystem path, which closes off
 * zip-slip (path traversal via `../..`) as a concern before it can become
 * one — there is no path to traverse into. `zip.test.ts` proves this
 * directly against a crafted `../../../etc/evil.jpg` entry name, not just
 * by this comment's own say-so (review finding).
 *
 * **No entry is ever decompressed, by construction — not size-limited,
 * never at all.** `accept()` below is fflate's `filter` callback, which
 * fflate calls with each entry's CENTRAL DIRECTORY metadata (name,
 * declared uncompressed size) before it would decompress anything. This
 * module reads the filename and declared size it needs directly from
 * that metadata and then always returns `false` — never `true` — so
 * fflate never inflates a single entry's real bytes, accepted or not.
 * `unzipSync`'s own return value is therefore always `{}` and is
 * discarded without being read.
 *
 * **On trusting the declared size at all.** A zip's declared uncompressed
 * size is attacker-controlled input, the same as every other byte in the
 * file (standing rule 18) — nothing here treats it as verified fact.
 * Because no entry is ever decompressed, a declared size that
 * under-states or over-states an entry's real inflated size cannot force
 * this module to inflate more than zero bytes for it either way: the
 * declared value is used only for this module's own bookkeeping
 * (`sizeBytes` in the returned `BatchImageRef`, and the running total
 * checked against `maxTotalBytes`), never as a basis for deciding how
 * much to decompress, because nothing is ever decompressed. A
 * lied-about-small declared size cannot sneak a large real payload past
 * the running-total check either: reaching `pairing.ts`'s "this file is
 * too large" or downstream extraction step still depends on whoever
 * reads the real bytes later (LH-041) checking them against its own
 * limits — this module's job is only the filename/size preview, and it
 * makes no promise about what a later reader of the real zip bytes will
 * see. (An earlier draft of this module DID return `true` for accepted
 * entries and let fflate actually inflate them, relying on fflate's own
 * internal behavior of bounding real inflate output to the declared size
 * — verified empirically, against a hand-crafted zip lying in both
 * directions, to genuinely hold for the fflate version this project
 * pins. That reliance is no longer needed: always returning `false`
 * removes the question entirely rather than resting on an unstated,
 * version-specific implementation detail.)
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
