/**
 * The Haiku extractor's structured-output schema (LH-011 / TRO-461).
 *
 * CP-1-approved verbatim (docs/checkpoints/cp1-cascade-router-prompts.md
 * §3.4). Passed as `output_config.format.schema` on the API request — never
 * the deprecated `output_format` (CP-1 §3.5).
 *
 * A nullable field uses `anyOf`, not a two-element `type` array — the
 * documented supported keyword. `confidence` carries no `minimum`/`maximum`;
 * structured outputs do not support numeric range keywords, so an
 * out-of-range value is a Validation Router concern (CP-1 §4.4), not a
 * schema constraint.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "image_quality",
    "brand_name",
    "class_type",
    "alcohol_content",
    "net_contents",
    "beverage_type",
    "government_warning",
  ],
  properties: {
    image_quality: {
      type: "object",
      additionalProperties: false,
      required: ["legible", "issues", "confidence"],
      properties: {
        legible: { type: "string", enum: ["yes", "partial", "no"] },
        issues: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "glare",
              "blur",
              "rotation",
              "low_light",
              "cropped",
              "obstructed",
              "low_resolution",
              "none",
            ],
          },
        },
        confidence: { type: "number" },
      },
    },
    brand_name: { $ref: "#/$defs/field" },
    class_type: { $ref: "#/$defs/field" },
    alcohol_content: { $ref: "#/$defs/field" },
    net_contents: { $ref: "#/$defs/field" },
    beverage_type: { $ref: "#/$defs/field" },
    government_warning: {
      type: "object",
      additionalProperties: false,
      required: [
        "present",
        "transcription",
        "prefix_casing",
        "formatting",
        "evidence",
        "confidence",
      ],
      properties: {
        present: { type: "boolean" },
        transcription: { anyOf: [{ type: "string" }, { type: "null" }] },
        prefix_casing: {
          type: "string",
          enum: ["ALL_CAPS", "TITLE_CASE", "OTHER", "NOT_VISIBLE"],
        },
        formatting: {
          type: "object",
          additionalProperties: false,
          required: ["bold"],
          properties: {
            bold: { type: "string", enum: ["true", "false", "uncertain"] },
          },
        },
        evidence: { type: "string" },
        confidence: { type: "number" },
      },
    },
  },
  $defs: {
    field: {
      type: "object",
      additionalProperties: false,
      required: ["value", "evidence", "confidence", "alternates"],
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
        evidence: { type: "string" },
        confidence: { type: "number" },
        alternates: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;
