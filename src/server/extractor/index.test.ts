import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { HaikuExtractionError } from "./response";
import { extractLabel, getDefaultExtractorClient } from "./index";
import { HAIKU_EXTRACTOR_MODEL } from "./request";
import { WELL_FORMED_EXTRACTION_BODY, makeMockMessage } from "./test-support";
import type { PreprocessedLabelImage } from "./types";

const IMAGE: PreprocessedLabelImage = { data: "ZmFrZS1pbWFnZQ==", mediaType: "image/jpeg" };

/** Fakes just the surface `extractLabel` uses — never a real Anthropic client in the unit suite. */
function fakeClient(
  create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>,
) {
  return { messages: { create: vi.fn(create) } } as unknown as Anthropic;
}

describe("extractLabel", () => {
  it("sends the image and the CP-1 model to the injected client, and returns the parsed result", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY)));

    const result = await extractLabel(IMAGE, { client });

    // Identity-critical fields, asserted independently of buildExtractionRequestParams
    // — byte-for-byte request validation belongs to request.test.ts; this test only
    // confirms extractLabel wires the image and model through to the client call.
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const sentParams = vi.mocked(client.messages.create).mock.calls[0][0];
    expect(sentParams.model).toBe(HAIKU_EXTRACTOR_MODEL);
    expect(sentParams.messages).toHaveLength(1);
    const content = sentParams.messages[0].content;
    if (typeof content === "string" || !Array.isArray(content)) {
      throw new Error("expected an array of content blocks");
    }
    const imageBlock = content.find((block) => block.type === "image");
    if (!imageBlock || imageBlock.type !== "image" || imageBlock.source.type !== "base64") {
      throw new Error("expected a base64 image content block");
    }
    expect(imageBlock.source.data).toBe(IMAGE.data);
    expect(imageBlock.source.media_type).toBe(IMAGE.mediaType);

    expect(result.brand_name.value).toBe("Old Tom Distillery");
    expect(result.government_warning.transcription).toBe(
      WELL_FORMED_EXTRACTION_BODY.government_warning.transcription,
    );
  });

  it("never calls the client more than once — no retry-as-a-second-opinion", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY)));
    await extractLabel(IMAGE, { client });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("throws HaikuExtractionError, not a silent partial result, on a malformed response", async () => {
    const client = fakeClient(async () => makeMockMessage("{not json"));
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

describe("getDefaultExtractorClient", () => {
  it("returns the same client instance on every call — one client, reused across labels", () => {
    const first = getDefaultExtractorClient();
    const second = getDefaultExtractorClient();
    expect(first).toBe(second);
  });

  it("sets an explicit timeout and retry count instead of the SDK's long-completion defaults", () => {
    const client = getDefaultExtractorClient();
    expect(client.timeout).toBe(30_000);
    // 0, not the SDK default of 2 — see the DEFAULT_CLIENT_MAX_RETRIES
    // comment in index.ts for why this batch/latency-budget call overrides it.
    expect(client.maxRetries).toBe(0);
  });
});
