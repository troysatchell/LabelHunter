/**
 * Postgres-backed storage for uploaded label images (TRO-518).
 *
 * Replaces `local-file-storage.ts` (deleted by this ticket). That module
 * wrote each image to a directory on the running process's own filesystem —
 * correct for local dev (`pnpm dev` runs the whole app in one process) but
 * broken once actually deployed: `render.yaml` runs `web` (writes the
 * image — `POST /api/verify`, `POST /api/batch/start`) and `worker` (reads
 * it back — `extract-worker.ts`, `resolve-worker.ts`) as two separate
 * Render services with two separate disks. A file `web` wrote was never
 * visible to `worker`. See `schema.ts`'s `labelImageBlobs` doc comment and
 * CHANGES.md's TRO-518 entry for the size/scale/quota numbers behind
 * choosing Postgres over a new S3-compatible bucket.
 *
 * This module keeps the exact interface `local-file-storage.ts` exposed —
 * `saveLabelImage(bytes, originalFilename) -> { storagePath }`,
 * `readLabelImage(storagePath) -> bytes` — so every production caller
 * needed only its import path updated. One caller needed a real logic
 * change, not just an import swap:
 * `src/app/api/label-images/[labelImageId]/route.ts`'s missing-image check
 * used to test a Node `fs` error code (`ENOENT`); it now checks
 * `LabelImageNotFoundError` (below), the database-shaped equivalent.
 *
 * Writes and reads go through the SAME shared, hardened `db` client every
 * other module in this app already uses (`../../lib/db`) — never a second
 * `new Pool(...)` (lessons.md #22). `options.db` exists only so a test can
 * inject a genuinely separate connection and prove a real cross-connection
 * round trip (`db-image-storage.test.ts`'s own "cross-process round trip"
 * suite) — production code never sets it.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, type SQL } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import { labelImageBlobs, labelImages } from "../../lib/db/schema";

export interface LabelImageStorageOptions {
  /** Injectable database client. Defaults to the shared, hardened `db`
   * (`../../lib/db`). */
  db?: typeof defaultDb;
}

export interface SavedLabelImage {
  /** Opaque outside this module — an app-generated key into
   * `label_image_blobs`, not a filesystem path. Stored in
   * `label_images.storage_path`, exactly where `local-file-storage.ts`'s
   * own value used to live. */
  storagePath: string;
}

/**
 * Thrown by `readLabelImage` when no row exists for the given
 * `storagePath` — the database-shaped "not found," replacing the Node `fs`
 * `ENOENT` code `local-file-storage.ts`'s callers used to check.
 * `label-images/[labelImageId]/route.ts` is the one caller that
 * distinguishes this from any other read failure (a designed 404, never a
 * 500 — TH-R20).
 */
export class LabelImageNotFoundError extends Error {
  constructor(storagePath: string) {
    super(`No stored image found for storagePath ${JSON.stringify(storagePath)}`);
    this.name = "LabelImageNotFoundError";
  }
}

/**
 * Writes `bytes` to `label_image_blobs` under a freshly generated key and
 * returns that key as `storagePath`.
 *
 * `originalFilename` is accepted for interface parity with the old
 * disk-backed signature (every caller already passes it) and stored on the
 * row for human debugging only — no code path reads it back. It plays no
 * role in generating `storagePath`: a Postgres primary key needs no
 * filename-collision handling the way a shared directory did, so unlike
 * `local-file-storage.ts`'s old `sanitizeFilenameComponent`, there is no
 * path-traversal surface here to defend either — a bare `randomUUID()` key
 * cannot be crafted into an escape.
 */
export async function saveLabelImage(
  bytes: Buffer,
  originalFilename: string,
  options: LabelImageStorageOptions = {},
): Promise<SavedLabelImage> {
  const db = options.db ?? defaultDb;
  const storageKey = randomUUID();
  await db.insert(labelImageBlobs).values({ storageKey, bytes, originalFilename });
  return { storagePath: storageKey };
}

/**
 * Reads back the bytes `saveLabelImage` wrote, given the `storagePath`
 * value that call returned (TRO-466, PRD §5 — the Detail view's
 * side-by-side label image).
 *
 * Throws `LabelImageNotFoundError` — never returns empty bytes — when no
 * row matches `storagePath`, including when `storagePath` is not even a
 * value this table would contain (e.g. a legacy filesystem-style path from
 * before this ticket). Standing rule 12: uncertain beats wrong.
 */
export async function readLabelImage(storagePath: string, options: LabelImageStorageOptions = {}): Promise<Buffer> {
  const db = options.db ?? defaultDb;
  const [row] = await db.select({ bytes: labelImageBlobs.bytes }).from(labelImageBlobs).where(eq(labelImageBlobs.storageKey, storagePath));
  if (!row) throw new LabelImageNotFoundError(storagePath);
  return row.bytes;
}

/**
 * Test-only cleanup helper. `label_images.storage_path` is deliberately
 * NOT a declared foreign key into `label_image_blobs` (see that table's
 * own `schema.ts` comment — a placeholder fixture value like
 * `"test-fixtures/x.jpg"` is a legal `storage_path` matching no row here),
 * so Postgres's own cascading delete on `applications`/`batch_jobs` never
 * reaches a blob row a test actually saved through `saveLabelImage`.
 * Without this, every test fixture that saves a real image (rather than a
 * placeholder `storagePath` string) leaks one `label_image_blobs` row into
 * the worktree's database for the rest of that database's life.
 *
 * Every test-support fixture cleanup that deletes `applications`/
 * `batch_jobs` rows by some condition calls this FIRST, with the matching
 * condition against `label_images` (e.g. `eq(labelImages.applicationId,
 * id)`), while the `label_images` rows it needs to find `storage_path`
 * from still exist — this function does not itself cascade from anything,
 * it looks up then deletes.
 */
export async function deleteLabelImageBlobsWhere(labelImagesWhere: SQL, options: LabelImageStorageOptions = {}): Promise<void> {
  const db = options.db ?? defaultDb;
  const rows = await db.select({ storagePath: labelImages.storagePath }).from(labelImages).where(labelImagesWhere);
  if (rows.length === 0) return;
  await db.delete(labelImageBlobs).where(
    inArray(
      labelImageBlobs.storageKey,
      rows.map((row) => row.storagePath),
    ),
  );
}
