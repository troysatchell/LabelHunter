import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { HaikuExtractionError } from "./response";
import { extractLabel } from "./index";
import { buildExtractionRequestParams } from "./request";
import type { PreprocessedLabelImage } from "./types";

function makeMessage(text: string): Anthropic.Message {
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
  };
}

const IMAGE: PreprocessedLabelImage = { data: "ZmFrZS1pbWFnZQ==", mediaType: "image/jpeg" };

const WELL_FORMED_BODY = {
  image_quality: { legible: "yes", issues: ["none"], confidence: 0.97 },
  brand_name: { value: "Old Tom Distillery", evidence: "OLD TOM DISTILLERY", confidence: 0.95, alternates: [] },
  class_type: { value: "Straight Bourbon Whiskey", evidence: "Straight Bourbon Whiskey", confidence: 0.92, alternates: [] },
  alcohol_content: { value: "45% Alc./Vol. (90 Proof)", evidence: "45% Alc./Vol. (90 Proof)", confidence: 0.9, alternates: [] },
  net_contents: { value: "750 mL", evidence: "750 mL", confidence: 0.93, alternates: [] },
  beverage_type: { value: "spirits", evidence: "Straight Bourbon Whiskey", confidence: 0.88, alternates: [] },
  government_warning: {
    present: true,
    transcription: "GOVERNMENT WARNING: ...",
    prefix_casing: "ALL_CAPS",
    formatting: { bold: "uncertain" },
    evidence: "GOVERNMENT WARNING: ...",
    confidence: 0.96,
  },
};

/** Fakes just the surface `extractLabel` uses — never a real Anthropic client in the unit suite. */
function fakeClient(create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>) {
  return { messages: { create: vi.fn(create) } } as unknown as Anthropic;
}

describe("extractLabel", () => {
  it("calls the injected client exactly once with the built request params", async () => {
    const client = fakeClient(async () => makeMessage(JSON.stringify(WELL_FORMED_BODY)));

    const result = await extractLabel(IMAGE, { client });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(client.messages.create).toHaveBeenCalledWith(buildExtractionRequestParams(IMAGE));
    expect(result.brand_name.value).toBe("Old Tom Distillery");
    expect(result.government_warning.transcription).toBe("GOVERNMENT WARNING: ...");
  });

  it("never calls the client more than once — no retry-as-a-second-opinion", async () => {
    const client = fakeClient(async () => makeMessage(JSON.stringify(WELL_FORMED_BODY)));
    await extractLabel(IMAGE, { client });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("throws HaikuExtractionError, not a silent partial result, on a malformed response", async () => {
    const client = fakeClient(async () => makeMessage("{not json"));
    await expect(extractLabel(IMAGE, { client })).rejects.toThrow(HaikuExtractionError);
  });

  it("propagates a transport error from the client without retrying", async () => {
    const client = fakeClient(async () => {
      throw new Error("network down");
    });
    await expect(extractLabel(IMAGE, { client })).rejects.toThrow("network down");
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });
});
