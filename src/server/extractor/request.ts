/**
 * Builds the Haiku extractor API request (LH-011 / TRO-461, CP-1 §3.5).
 *
 * One call per label. The system prompt, user message, and schema are the
 * CP-1-approved bytes from `prompt.ts` and `schema.ts` — this module only
 * assembles them into the request shape the Anthropic SDK expects.
 *
 * API settings, each tied to a confirmed fact (CP-1 §3.5):
 *   - `output_config.format` carries the strict JSON schema. Never the
 *     deprecated `output_format`.
 *   - No `effort`. `claude-haiku-4-5` rejects it — confirmed live, a 400
 *     with "This model does not support the effort parameter."
 *   - `temperature: 0` for reproducibility. Confirmed live: accepted.
 *   - No `cache_control`. This prompt is under the 4096-token minimum
 *     cacheable prefix on `claude-haiku-4-5` — confirmed live:
 *     `cache_creation_input_tokens: 0` with the marker present. Adding the
 *     marker changes nothing; leave it out.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_JSON_SCHEMA } from "./schema";
import { SYSTEM_PROMPT, USER_MESSAGE_TEXT } from "./prompt";
import type { PreprocessedLabelImage } from "./types";

/**
 * The model ID for the extractor (PRD §4, CP-1 §3.5). Confirmed live against
 * `GET /v1/models/claude-haiku-4-5` on 2026-08-10 — resolves to
 * `claude-haiku-4-5-20251001`, `structured_outputs.supported: true`,
 * `image_input.supported: true`.
 */
export const HAIKU_EXTRACTOR_MODEL: Anthropic.Model = "claude-haiku-4-5";

/**
 * Output token ceiling for one extraction. CP-1 §7.1 assumes ~600 output
 * tokens for six fields plus evidence strings; this leaves headroom for a
 * long government-warning transcription without approaching the model's
 * 64K cap (so no streaming is needed for this call).
 */
const MAX_OUTPUT_TOKENS = 2048;

/**
 * Builds the request body for one Haiku extraction call. Pure and
 * deterministic — the same image always produces the same request shape, so
 * this is unit-testable without calling the API.
 */
export function buildExtractionRequestParams(
  image: PreprocessedLabelImage,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: HAIKU_EXTRACTOR_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    system: SYSTEM_PROMPT,
    output_config: {
      format: {
        type: "json_schema",
        schema: EXTRACTION_JSON_SCHEMA,
      },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.data,
            },
          },
          {
            type: "text",
            text: USER_MESSAGE_TEXT,
          },
        ],
      },
    ],
  };
}
