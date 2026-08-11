/**
 * Local-disk storage for uploaded label images (TRO-465, PRD §2 item 5 —
 * "persistence is a committed core feature").
 *
 * No storage ticket has landed yet (S3, Render disk, or otherwise) — this
 * writes the preprocessed original image to a directory on the running
 * process's own filesystem and records that path in `label_images.storage_path`
 * (`src/lib/db/schema.ts`). Honest about what it is: a prototype-appropriate
 * stand-in, not a durable object store. On Render's ephemeral filesystem a
 * deploy or restart can lose these files — the database row survives, the
 * bytes may not. Acceptable for a take-home prototype; a real deployment
 * would swap this module for an S3-backed one without touching its
 * callers, since `saveLabelImage`'s signature does not leak the local-disk
 * detail into `src/app/api/verify/route.ts`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Default base directory: `var/uploads` under the process's cwd (the repo
 * root in dev, the deployed app's root on Render). Gitignored — uploaded
 * label images are never committed. */
const DEFAULT_BASE_DIR = path.join(process.cwd(), "var", "uploads");

export interface SaveLabelImageOptions {
  /** Overrides the base directory — tests point this at a scratch dir so
   * they never write into the real `var/uploads`. */
  baseDir?: string;
}

export interface SavedLabelImage {
  /** Relative path stored in `label_images.storage_path`. Relative, not
   * absolute — an absolute path would bake this one machine's directory
   * layout into the database. */
  storagePath: string;
  /** Absolute path on disk, for callers (like the route) that need to know
   * where the file actually landed. */
  absolutePath: string;
}

/** Keeps only characters safe in a filename across the platforms this app
 * runs on (dev on macOS/Linux, deployed on Render's Linux). Everything else
 * — including path separators, so a crafted "../../etc/passwd" filename
 * cannot escape `baseDir` — becomes an underscore. */
function sanitizeFilenameComponent(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "upload";
}

/**
 * Writes `bytes` to disk under `baseDir` (default `var/uploads`) with a
 * collision-proof name, creating the directory if needed. Returns the path
 * to store in `label_images.storage_path` (relative to `baseDir`'s parent
 * is NOT assumed by any reader — the stored value is opaque outside this
 * module, exactly the property that makes swapping in a real object store
 * later a one-file change) plus the absolute path actually written.
 */
export async function saveLabelImage(
  bytes: Buffer,
  originalFilename: string,
  options: SaveLabelImageOptions = {},
): Promise<SavedLabelImage> {
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
  await mkdir(baseDir, { recursive: true });

  const safeName = sanitizeFilenameComponent(originalFilename);
  const filename = `${randomUUID()}-${safeName}`;
  const absolutePath = path.join(baseDir, filename);
  await writeFile(absolutePath, bytes);

  // `path.basename(baseDir)` rather than a hardcoded "uploads": stays
  // accurate when a caller (a test) overrides `baseDir` to a scratch
  // directory with a different name, instead of claiming a location the
  // file was never written to.
  return { storagePath: path.join(path.basename(baseDir), filename), absolutePath };
}
