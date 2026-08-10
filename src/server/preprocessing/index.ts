/**
 * Public entry point for the image preprocessing pipeline (TRO-460 /
 * LH-010, PRD §3.1). The Haiku extractor (LH-011) and the warning
 * subsystem (LH-020) import from here, not from the individual files.
 */
export {
  HAIKU_MAX_LONG_EDGE_PX,
  SONNET_MAX_LONG_EDGE_PX,
  MAX_UPLOAD_BYTES,
  MAX_INPUT_PIXELS,
  ALLOWED_INPUT_FORMATS,
  OUTPUT_MEDIA_TYPE,
  type AllowedInputFormat,
} from "./constants";
export {
  PreprocessingError,
  FileTooLargeError,
  UnsupportedFormatError,
  UnreadableImageError,
  ImageDimensionsTooLargeError,
} from "./errors";
export { type Dimensions, computeResizeDimensions } from "./resize";
export {
  type ExifOrientation,
  orientationSwapsDimensions,
  displayDimensions,
} from "./exif";
export { type PixelRegion, clampRegionToBounds } from "./region";
export { assertUploadSize, assertSupportedFormat } from "./validate";
export {
  type PreprocessedImage,
  type PreprocessImageOptions,
  preprocessImage,
  cropRegion,
} from "./pipeline";
