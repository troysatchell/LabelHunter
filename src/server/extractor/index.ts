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

/**
 * Request timeout for the shared default client, in milliseconds. The SDK's
 * own default (10 minutes) is sized for long streaming completions, not a
 * single small structured-output vision call. CP-1 §3.8 targets ~2.5s p50
 * for this call — not measured yet, so this is a safety net against a
 * hung request blocking a batch worker slot, not a claimed SLA.
 */
const DEFAULT_CLIENT_TIMEOUT_MS = 30_000;

/**
 * Retry count for the shared default client. Set to 0, not the SDK's own
 * default of 2 — a deliberate choice, not an oversight. A batch run holds a
 * worker-pool slot per in-flight extraction (PRD §3.5), and TH-R2's 5-second
 * budget applies to the interactive path; an SDK-level retry with
 * exponential backoff can silently add several seconds neither budget
 * accounts for, and it would run underneath — not coordinated with — the
 * batch worker's own rate-limit backoff once CP-3 builds it. Failing fast
 * on a 429/5xx and letting the caller decide whether to retry keeps that
 * one policy in one place. This is unrelated to "no retry-as-a-second-
 * opinion" (this module never re-asks the model for a different read after
 * a successful call) — that rule is about judgment, not transport.
 */
const DEFAULT_CLIENT_MAX_RETRIES = 0;

let defaultClient: Anthropic | undefined;

/**
 * The shared default Anthropic client `extractLabel` uses when no client is
 * injected. Constructed once and reused — a batch run extracts hundreds of
 * labels (PRD §3.5), and building a fresh client per call is needless work.
 * Reads `ANTHROPIC_API_KEY` from the environment; never hard-code the key.
 */
export function getDefaultExtractorClient(): Anthropic {
  if (!defaultClient) {
    defaultClient = new Anthropic({
      timeout: DEFAULT_CLIENT_TIMEOUT_MS,
      maxRetries: DEFAULT_CLIENT_MAX_RETRIES,
    });
  }
  return defaultClient;
}

export interface ExtractLabelOptions {
  /**
   * Anthropic client to use. Defaults to the shared client from
   * `getDefaultExtractorClient()`. Inject a client with a mocked
   * `messages.create` in tests; the unit suite never calls the real API.
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
  const client = options.client ?? getDefaultExtractorClient();
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
