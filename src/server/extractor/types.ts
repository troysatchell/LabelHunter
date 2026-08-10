/**
 * Types for the Haiku extractor (LH-011 / TRO-461, PRD §3.2, CP-1 §3).
 *
 * The extractor answers one question: what does this label say? These types
 * describe its input (a preprocessed label image) and its output (the strict
 * JSON schema in `schema.ts`, typed here). They do not describe a verdict —
 * comparing the extraction to an application record is the Validation
 * Router's job (LH-012 / LH-013), not this module's.
 */

/** Image formats the Anthropic vision API accepts for a base64 image block. */
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * A label image ready to send to the extractor. Preprocessing (EXIF
 * rotation, resize to the Haiku vision cap) is LH-010's job — this module
 * takes the result, not a raw upload.
 */
export interface PreprocessedLabelImage {
  /** Base64-encoded image bytes. No `data:` URI prefix. */
  data: string;
  mediaType: ImageMediaType;
}

/** The three legibility bands the extractor reports for the whole image. */
export type ImageLegibility = "yes" | "partial" | "no";

/** Why the image is hard to read. `"none"` means no issue found. */
export type ImageQualityIssue =
  | "glare"
  | "blur"
  | "rotation"
  | "low_light"
  | "cropped"
  | "obstructed"
  | "low_resolution"
  | "none";

/** The extractor's read on the whole image, not one field (CP-1 §3.3). */
export interface ExtractedImageQuality {
  legible: ImageLegibility;
  issues: ImageQualityIssue[];
  confidence: number;
}

/**
 * One extracted field: `brand_name`, `class_type`, `alcohol_content`,
 * `net_contents`, or `beverage_type` (CP-1 §3.4). Every field carries its
 * own evidence — a bare value with no supporting text is not a valid read
 * (PRD §3.2).
 */
export interface ExtractedField {
  /** The field content, surrounding words removed. `null` when absent or unreadable. */
  value: string | null;
  /** Verbatim text copied from the label. Empty string when `value` is `null`. */
  evidence: string;
  /** 0.00–1.00. The model's own estimate — an ordinal signal, not a probability. */
  confidence: number;
  /** A second reading, when the label states the same field two different ways. */
  alternates: string[];
}

/** Capitalization of the words before the warning's colon (CP-1 §3.2, Jenny's catch). */
export type WarningPrefixCasing = "ALL_CAPS" | "TITLE_CASE" | "OTHER" | "NOT_VISIBLE";

/** Whether the warning text looks bold. `"uncertain"` unless the weight difference is obvious. */
export type WarningBoldness = "true" | "false" | "uncertain";

/**
 * The government warning field. It has no single `value` — a paragraph of
 * statutory text does not reduce to one field the way a brand name does
 * (CP-1 §3.4) — so it carries `present` and `transcription` instead.
 */
export interface ExtractedGovernmentWarning {
  present: boolean;
  /** Verbatim transcription of the whole warning block. `null` when not present. */
  transcription: string | null;
  prefix_casing: WarningPrefixCasing;
  formatting: {
    bold: WarningBoldness;
  };
  /** Verbatim text copied from the label, supporting `transcription`. */
  evidence: string;
  confidence: number;
}

/**
 * The full Haiku extraction result — the parsed and validated JSON schema
 * response (CP-1 §3.4). This is what the label says, not what it means; the
 * Validation Router compares it to the application record.
 */
export interface HaikuExtractionResult {
  image_quality: ExtractedImageQuality;
  brand_name: ExtractedField;
  class_type: ExtractedField;
  alcohol_content: ExtractedField;
  net_contents: ExtractedField;
  beverage_type: ExtractedField;
  government_warning: ExtractedGovernmentWarning;
}
