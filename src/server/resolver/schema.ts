/**
 * The Sonnet resolver's structured-output schema (LH-014 / TRO-464).
 *
 * CP-1-approved verbatim (docs/checkpoints/cp1-cascade-router-prompts.md
 * §6.4). Passed as `output_config.format.schema` on the API request — never
 * the deprecated `output_format` (CP-1 §6.6, same rule as the extractor).
 *
 * This schema is shared across all six field values in `field` — it is not
 * split per field even though `government_warning` never legitimately
 * carries a judged disposition and `beverage_type` is never actually
 * flagged (CP-1 open question 12). That split is a real, named gap CP-1
 * leaves for Troy to decide, not adopted here; `response.ts` enforces the
 * judges-only-brand/class rule at the parsing boundary instead, so a
 * schema-legal-but-forbidden disposition (e.g. a judged `RESOLVED_MATCH` on
 * `government_warning`) can never reach a caller as an authoritative verdict.
 */
export const RESOLVER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overall", "fields"],
  properties: {
    overall: { type: "string", enum: ["RESOLVED", "NEEDS_HUMAN"] },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "disposition", "corrected_value", "evidence", "reason", "confidence"],
        properties: {
          field: {
            type: "string",
            enum: [
              "brand_name",
              "class_type",
              "alcohol_content",
              "net_contents",
              "government_warning",
              "beverage_type",
            ],
          },
          disposition: {
            type: "string",
            enum: ["RESOLVED_MATCH", "RESOLVED_MISMATCH", "NEEDS_HUMAN"],
          },
          corrected_value: { anyOf: [{ type: "string" }, { type: "null" }] },
          evidence: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;
