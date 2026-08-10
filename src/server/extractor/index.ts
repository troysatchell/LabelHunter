/**
 * The Haiku extractor (LH-011 / TRO-461, PRD §3.2, CP-1 §3).
 *
 * Public entry point: `extractLabel(image)`. It answers one question — what
 * does this label say? — with one Haiku call, strict JSON output, and no
 * knowledge of the application record (CP-1 §3.1: no anchoring). The
 * Validation Router (LH-012 / LH-013) compares the result to the
 * application; this module never does that comparison, and it never calls
 * Sonnet (TH-R19 — the cascade is the architecture, not an optimization).
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildExtractionRequestParams } from "./request";
import { parseExtractionResponse } from "./response";
import type { HaikuExtractionResult, PreprocessedLabelImage } from "./types";

export interface ExtractLabelOptions {
  /**
   * Anthropic client to use. Defaults to a new client, which reads
   * `ANTHROPIC_API_KEY` from the environment — never hard-code the key.
   * Inject a client with a mocked `messages.create` in tests; the unit
   * suite never calls the real API.
   */
  client?: Anthropic;
}

/**
 * Reads one label image with the Haiku extractor. One call per label — no
 * retry-as-a-second-opinion, and this function never escalates to Sonnet.
 * Throws `HaikuExtractionError` (see `response.ts`) when the response is
 * refused, incomplete, or does not match the schema.
 */
export async function extractLabel(
  image: PreprocessedLabelImage,
  options: ExtractLabelOptions = {},
): Promise<HaikuExtractionResult> {
  const client = options.client ?? new Anthropic();
  const params = buildExtractionRequestParams(image);
  const message = await client.messages.create(params);
  return parseExtractionResponse(message);
}

export { HAIKU_EXTRACTOR_MODEL, buildExtractionRequestParams } from "./request";
export { SYSTEM_PROMPT, USER_MESSAGE_TEXT } from "./prompt";
export { EXTRACTION_JSON_SCHEMA } from "./schema";
export {
  HaikuExtractionError,
  parseExtractionResponse,
  validateExtractionResult,
} from "./response";
export type {
  ExtractedField,
  ExtractedGovernmentWarning,
  ExtractedImageQuality,
  HaikuExtractionResult,
  ImageLegibility,
  ImageMediaType,
  ImageQualityIssue,
  PreprocessedLabelImage,
  WarningBoldness,
  WarningPrefixCasing,
} from "./types";
