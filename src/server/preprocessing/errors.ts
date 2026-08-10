/**
 * Preprocessing error types (TRO-460 / LH-010, TH-R20).
 *
 * TH-R20 asks for a UI a first-time user can operate with no instructions.
 * A generic 500 fails that test. Every rejection here carries a specific,
 * plain-language reason a real person can act on: pick a smaller file,
 * upload a different format, or take a new photo.
 *
 * Standing rule 12 (uncertain beats wrong, TH-R10): these errors cover
 * structurally invalid input — wrong format, corrupt file, oversized file.
 * A valid-but-blurry photo is not rejected here; it passes through to
 * extraction, where a later ticket (LH-051) decides whether the read
 * quality is good enough to trust.
 */

/** Base class for every preprocessing rejection. Catch this to handle all of them alike. */
export abstract class PreprocessingError extends Error {
  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** The upload is larger than `MAX_UPLOAD_BYTES` (constants.ts). */
export class FileTooLargeError extends PreprocessingError {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(
      `This file is ${humanBytes(byteLength)}. The limit is ${humanBytes(maxBytes)}. Choose a smaller image.`,
    );
    this.name = "FileTooLargeError";
  }
}

/**
 * The file is not one of `ALLOWED_INPUT_FORMATS` (constants.ts) — either
 * sharp could not detect any image format at all, or it detected a format
 * LabelHunter does not accept (e.g. GIF, TIFF).
 */
export class UnsupportedFormatError extends PreprocessingError {
  constructor(readonly detectedFormat: string | undefined) {
    super(
      "LabelHunter cannot read this file type. Upload a JPEG, PNG, WEBP, or HEIC photo.",
    );
    this.name = "UnsupportedFormatError";
  }
}

/**
 * The file has a recognizable image format but its data is damaged —
 * truncated, corrupt, or otherwise fails to decode.
 */
export class UnreadableImageError extends PreprocessingError {
  constructor(cause?: unknown) {
    super(
      "LabelHunter cannot open this file. It may be damaged. Take a new photo and try again.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "UnreadableImageError";
  }
}

/**
 * The file decodes to more pixels than `MAX_INPUT_PIXELS` allows — a guard
 * against a small, crafted file that expands to an enormous image
 * ("decompression bomb") independent of its byte size on disk.
 */
export class ImageDimensionsTooLargeError extends PreprocessingError {
  constructor() {
    super("This image is too large to process. Choose a smaller image.");
    this.name = "ImageDimensionsTooLargeError";
  }
}

/** Renders a byte count as a short, human-readable size, e.g. "3.4 MB". */
function humanBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
