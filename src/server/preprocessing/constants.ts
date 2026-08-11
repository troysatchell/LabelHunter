/**
 * Preprocessing constants (TRO-460 / LH-010, PRD §3.1).
 *
 * `HAIKU_MAX_LONG_EDGE_PX` and `SONNET_MAX_LONG_EDGE_PX` are the two
 * documented Claude vision resolution caps this ticket must confirm
 * (docs/checkpoints/cp1-cascade-router-prompts.md §3.5). Both are
 * confirmed live against the API on 2026-08-10 — see CHANGES.md and the
 * TRO-460 report for the measured evidence.
 */

/**
 * `claude-haiku-4-5` is standard-resolution vision. A live smoke test on
 * 2026-08-10 sent a 3200×2400 test image and measured 1582 input tokens
 * (about 1568–1572 after subtracting the text prompt) — matching a resize
 * to a 1568px long edge. This confirms PRD §3.7's stated Haiku cap.
 */
export const HAIKU_MAX_LONG_EDGE_PX = 1568;

/**
 * `claude-sonnet-5` is high-resolution vision. The same live smoke test
 * measured 4761 input tokens for the identical source image — about 3.0×
 * the Haiku figure, matching a resize to a 2576px long edge and Anthropic's
 * documented ~4784-token figure at that limit. This confirms PRD §3.7's
 * stated Sonnet cap.
 */
export const SONNET_MAX_LONG_EDGE_PX = 2576;

/**
 * Upload size ceiling: 20 MB. Generous for a real phone photo (a HEIC
 * capture from a modern phone is typically 2–8 MB; a high-resolution JPEG
 * rarely exceeds 15 MB) while bounding worst-case processing cost. TH-R20:
 * a file over this limit gets a specific, human-readable error, never a
 * generic 500.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Decoded pixel-count ceiling: 100 megapixels. A byte-size ceiling alone
 * does not stop a small, crafted file that decodes to an enormous image
 * (a "decompression bomb") — this bounds decode time and memory
 * independently of the file's size on disk. 100 MP is far above any real
 * label photo (a 45-megapixel medium-format camera is the practical
 * ceiling for a consumer device) so no legitimate upload hits it.
 */
export const MAX_INPUT_PIXELS = 100_000_000;

/**
 * Raster formats LabelHunter accepts. `heif` covers HEIC, the default
 * capture format on recent iPhones. `sharp` (via libvips) can also decode
 * gif/tiff/svg/avif, but none of those are realistic outputs of "photograph
 * a label", so they are rejected rather than silently accepted.
 */
export const ALLOWED_INPUT_FORMATS = ["jpeg", "png", "webp", "heif"] as const;
export type AllowedInputFormat = (typeof ALLOWED_INPUT_FORMATS)[number];

/**
 * Every pipeline output (original, Haiku variant, Sonnet variant, and any
 * later warning-region crop) is re-encoded to JPEG, regardless of the
 * upload's source format. Two reasons: the Claude vision API accepts only
 * image/jpeg, image/png, image/gif, and image/webp — never image/heic —
 * so a HEIC upload must convert before any extractor call; and a single
 * fixed output format means every downstream consumer (extractor, resolver,
 * a future OCR step) can assume one `mediaType` instead of branching on the
 * original upload's format.
 */
export const OUTPUT_MEDIA_TYPE = "image/jpeg" as const;
