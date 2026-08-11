/**
 * Builds the Sonnet resolver API request (LH-014 / TRO-464, CP-1 §6.6).
 *
 * One call per escalated label. The system prompt and output schema are the
 * CP-1-approved bytes from `prompt.ts` and `schema.ts`; the user message is
 * built per call by `user-message.ts`. This module only assembles the
 * request shape the Anthropic SDK expects.
 *
 * API settings, each tied to a CP-1 §6.6 / CHANGES.md-confirmed fact:
 *   - `output_config.format` carries the strict JSON schema — never the
 *     deprecated `output_format` (same rule as the extractor).
 *   - No `temperature`. `claude-sonnet-5` returns a 400 for sampling
 *     parameters — confirmed live during TRO-460 (CHANGES.md), reusing the
 *     same fact rather than re-asserting an unverified claim here.
 *   - `output_config.effort: "high"` — CP-1 §6.6 says "start at high (the
 *     default)". Set explicitly rather than left unset, so the golden-set
 *     effort sweep CP-1 §6.6 calls for (LH-030) has one obvious constant to
 *     change, not an absent field to first go add.
 *   - No `thinking` config. Adaptive thinking is on by default on
 *     `claude-sonnet-5` (CP-1 §6.6) — setting nothing IS the CP-1-approved
 *     choice, not an oversight.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { RESOLVER_JSON_SCHEMA } from "./schema";
import { SYSTEM_PROMPT } from "./prompt";
import { buildUserMessageText } from "./user-message";
import type { ResolverInput } from "./types";

/** The model ID for the resolver (PRD §4, CP-1 §6.6). */
export const SONNET_RESOLVER_MODEL: Anthropic.Model = "claude-sonnet-5";

/**
 * Output token ceiling for one resolver call. CP-1 §7.1 assumes ~2000
 * output tokens per escalation, INCLUDING adaptive-thinking tokens, which
 * bill as output on `claude-sonnet-5` (CP-1 §6.6/§7.1) — not measured for
 * this module specifically, so this ceiling is a generous safety margin
 * (4x the assumption), not a claimed budget.
 */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Builds the request body for one resolver call. Pure and deterministic
 * given its input — unit-testable without calling the API. Throws
 * `ResolverInputError` (via `buildUserMessageText`) rather than sending a
 * request built from an implausibly long untrusted value.
 */
export function buildResolverRequestParams(input: ResolverInput): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: SONNET_RESOLVER_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: {
      format: {
        type: "json_schema",
        schema: RESOLVER_JSON_SCHEMA,
      },
      effort: "high",
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: input.image.mediaType,
              data: input.image.data,
            },
          },
          {
            type: "text",
            text: buildUserMessageText(input),
          },
        ],
      },
    ],
  };
}
