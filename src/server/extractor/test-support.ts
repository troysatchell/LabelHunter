/**
 * Shared test fixtures for the extractor test suites (LH-011 / TRO-461).
 *
 * Not a `*.test.ts` file itself — vitest only collects files matching that
 * pattern (`vitest.config.ts`), so this module carries no test cases and
 * never runs on its own.
 */
import type Anthropic from "@anthropic-ai/sdk";

/** Builds a minimal, type-correct `Anthropic.Message` around one text block. */
export function makeMockMessage(
  text: string,
  overrides: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    container: null,
    stop_sequence: null,
    stop_details: null,
    stop_reason: "end_turn",
    content: [{ type: "text", text, citations: null }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
    ...overrides,
  };
}

/** A well-formed extraction JSON body, matching every required schema field. */
export const WELL_FORMED_EXTRACTION_BODY = {
  image_quality: { legible: "yes", issues: ["none"], confidence: 0.97 },
  brand_name: {
    value: "Old Tom Distillery",
    evidence: "OLD TOM DISTILLERY",
    confidence: 0.95,
    alternates: [],
  },
  class_type: {
    value: "Straight Bourbon Whiskey",
    evidence: "Straight Bourbon Whiskey",
    confidence: 0.92,
    alternates: [],
  },
  alcohol_content: {
    value: "45% Alc./Vol. (90 Proof)",
    evidence: "45% Alc./Vol. (90 Proof)",
    confidence: 0.9,
    alternates: [],
  },
  net_contents: {
    value: "750 mL",
    evidence: "750 mL",
    confidence: 0.93,
    alternates: [],
  },
  beverage_type: {
    value: "spirits",
    evidence: "Straight Bourbon Whiskey",
    confidence: 0.88,
    alternates: [],
  },
  government_warning: {
    present: true,
    transcription:
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not " +
      "drink alcoholic beverages during pregnancy because of the risk of birth " +
      "defects. (2) Consumption of alcoholic beverages impairs your ability to " +
      "drive a car or operate machinery, and may cause health problems.",
    prefix_casing: "ALL_CAPS",
    formatting: { bold: "uncertain" },
    evidence:
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not " +
      "drink alcoholic beverages during pregnancy because of the risk of birth " +
      "defects. (2) Consumption of alcoholic beverages impairs your ability to " +
      "drive a car or operate machinery, and may cause health problems.",
    confidence: 0.96,
  },
};
