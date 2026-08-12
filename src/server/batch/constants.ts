/**
 * Batch input size ceilings (TRO-473 / LH-040, TH-R20, standing rule 18 —
 * a CSV cell, a filename, and an uploaded archive are all adversarial
 * input the moment they cross an HTTP boundary).
 *
 * Every ceiling below turns a pathological upload into one clear, fast,
 * designed error instead of a slow request or an out-of-memory crash.
 * TH-R4's own scale reference (200-300 labels) sizes each number with
 * generous headroom above it. **Proposed starting values, not measured**
 * against a real deployment — the same status this codebase already gives
 * `MAX_UPLOAD_BYTES` (`src/server/preprocessing/constants.ts`) and CP-3's
 * own worker-pool sizes.
 */

/** A CSV manifest for a few hundred rows is at most a few hundred KB of
 * text. 5 MB is generous headroom above that. */
export const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

/** Applies to the combined image count from every source — multi-file
 * drop entries and zip entries together (`route.ts` checks the merged
 * total; `zip.ts`'s own `MAX_ZIP_ENTRIES` bounds the zip side alone before
 * this ticket's code ever sees the merged list). Comfortably above
 * TH-R4's 200-300 scale reference. */
export const MAX_IMAGE_COUNT = 1000;

/** A zip with more entries than this is almost certainly not a real batch
 * of label photos — reject it before spending any time on it. Directory
 * entries never count toward this (`zip.ts`). */
export const MAX_ZIP_ENTRIES = 1000;

/** Bounds this module's own bookkeeping against a zip's DECLARED
 * uncompressed content size, checked one entry at a time as `zip.ts`
 * reads each entry's central-directory metadata. `zip.ts`'s own file
 * comment explains why trusting that declared value for bookkeeping is
 * safe even though it is attacker-controlled input: no entry is ever
 * actually decompressed, by construction, so a lie in either direction
 * cannot force any real inflation, small or large. 500 MB is far above
 * 1000 label photos at a realistic few MB each. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

/** The uploaded zip FILE's own size on disk, checked before anything
 * reads or decompresses a single byte of it (`parse-request.ts`). A
 * separate, earlier check from `MAX_ZIP_UNCOMPRESSED_BYTES` above: that
 * one bounds what a zip's central directory CLAIMS its contents unpack
 * to; this one bounds the raw upload itself, cheaply, before any of that
 * metadata is even read. A real photo barely compresses further under
 * DEFLATE (JPEG is already compressed), so a real archive's size on disk
 * sits close to its real content size — 600 MB gives headroom above
 * `MAX_ZIP_UNCOMPRESSED_BYTES` for ordinary zip-container overhead
 * without being a materially looser ceiling. */
export const MAX_ZIP_ARCHIVE_BYTES = 600 * 1024 * 1024;

/** The whole multipart request. Two layers enforce this, in `route.ts`:
 * `checkRequestSize` is a cheap fast path that rejects from the
 * `Content-Length` header alone, before anything reads a byte, when that
 * header is present and already reveals the request is too large;
 * `readLimitedBody` is the AUTHORITATIVE check underneath it, measuring
 * the request's real bytes as they stream in and aborting the moment the
 * cap is exceeded, regardless of whether `Content-Length` was present,
 * absent, or understated (review finding — an earlier draft trusted the
 * header alone and left this ceiling meaningless for a request built
 * without one, which is this route's own normal shape for a `FormData`
 * body, confirmed empirically).
 *
 * Sized well above a full zip upload (`MAX_ZIP_ARCHIVE_BYTES`, 600 MB) so
 * it is never the first thing to reject a real batch, but deliberately
 * NOT the far looser 2 GB an earlier draft used: `readLimitedBody`
 * briefly holds the request's real bytes in memory while buffering them,
 * so this ceiling is also a bound on that peak memory use, on a service
 * instance this design cannot assume is generously provisioned. 1 GB
 * keeps roughly 400 MB of headroom above the zip-archive ceiling for a
 * manifest and any multi-file-drop entries, without inviting a
 * near-cap upload to threaten the process it is meant to protect. */
export const MAX_TOTAL_REQUEST_BYTES = 1 * 1024 * 1024 * 1024;
