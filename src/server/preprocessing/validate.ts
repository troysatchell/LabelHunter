/**
 * Format and size validation (TRO-460 / LH-010, TH-R20). Pure predicates —
 * no image decoding — so the ceiling checks are unit tested directly.
 */
import { ALLOWED_INPUT_FORMATS, MAX_UPLOAD_BYTES } from "./constants";
import { FileTooLargeError, UnsupportedFormatError } from "./errors";

/** Throws `FileTooLargeError` when `byteLength` exceeds `MAX_UPLOAD_BYTES`. */
export function assertUploadSize(byteLength: number): void {
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw new FileTooLargeError(byteLength, MAX_UPLOAD_BYTES);
  }
}

/**
 * Throws `UnsupportedFormatError` unless `detectedFormat` is one of
 * `ALLOWED_INPUT_FORMATS`. `detectedFormat` is `sharp`'s reported format
 * string (e.g. `"jpeg"`), or `undefined` when no format was detected.
 */
export function assertSupportedFormat(
  detectedFormat: string | undefined,
): void {
  if (
    detectedFormat === undefined ||
    !(ALLOWED_INPUT_FORMATS as readonly string[]).includes(detectedFormat)
  ) {
    throw new UnsupportedFormatError(detectedFormat);
  }
}
