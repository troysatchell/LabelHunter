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
 * of label photos — reject it before spending any time decompressing. */
export const MAX_ZIP_ENTRIES = 1000;

/** Bounds decompressed memory use regardless of the zip file's size on
 * disk — the same "decompression bomb" concern
 * `preprocessing/constants.ts`'s `MAX_INPUT_PIXELS` names for a single
 * image, applied here to a whole archive. `zip.ts` checks this against
 * each entry's OWN declared uncompressed size, one entry at a time, before
 * decompressing it — so a crafted entry that lies about being small still
 * cannot force a large real decompression. 500 MB is far above 1000 label
 * photos at a realistic few MB each. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
