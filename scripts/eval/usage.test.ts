import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { makeMockMessage } from "../../src/server/extractor/test-support";
import {
  buildMeasuredCost,
  computeCostUsd,
  createUsageCapturingClient,
  HAIKU_4_5_PRICING,
  SONNET_5_INTRO_PRICING,
} from "./usage";

function fakeClient(create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>) {
  return { messages: { create: vi.fn(create) } } as unknown as Anthropic;
}

describe("computeCostUsd", () => {
  it("prices input and output tokens at their own published rate", () => {
    const usd = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      HAIKU_4_5_PRICING,
    );
    expect(usd).toBeCloseTo(1 + 5, 10);
  });

  it("prices cache-write tokens at 1.25x the input rate", () => {
    const usd = computeCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 0 },
      HAIKU_4_5_PRICING,
    );
    expect(usd).toBeCloseTo(1.25, 10);
  });

  it("prices cache-read tokens at 0.1x the input rate", () => {
    const usd = computeCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000 },
      HAIKU_4_5_PRICING,
    );
    expect(usd).toBeCloseTo(0.1, 10);
  });

  it("uses Sonnet 5's intro rate, not the standard rate", () => {
    const usd = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      SONNET_5_INTRO_PRICING,
    );
    expect(usd).toBeCloseTo(2 + 10, 10);
  });

  it("returns 0 for zero usage", () => {
    expect(computeCostUsd({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, HAIKU_4_5_PRICING)).toBe(0);
  });
});

describe("buildMeasuredCost", () => {
  it("builds a MeasuredCost from a real Anthropic.Usage shape", () => {
    const usage: Anthropic.Usage = {
      input_tokens: 200,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    };
    const cost = buildMeasuredCost("claude-haiku-4-5", usage, HAIKU_4_5_PRICING);
    expect(cost).toEqual({
      model: "claude-haiku-4-5",
      inputTokens: 200,
      outputTokens: 40,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      usd: computeCostUsd({ inputTokens: 200, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, HAIKU_4_5_PRICING),
    });
  });
});

describe("createUsageCapturingClient", () => {
  it("captures the usage from the most recent messages.create call", async () => {
    const client = fakeClient(async () => makeMockMessage("hi", { usage: { ...makeMockMessage("hi").usage, input_tokens: 321, output_tokens: 7 } }));
    const capture = createUsageCapturingClient(client);

    await capture.client.messages.create({} as Anthropic.MessageCreateParamsNonStreaming);

    const usage = capture.takeLastUsage();
    expect(usage?.input_tokens).toBe(321);
    expect(usage?.output_tokens).toBe(7);
  });

  it("returns null when no call has happened yet", () => {
    const client = fakeClient(async () => makeMockMessage("unused"));
    const capture = createUsageCapturingClient(client);
    expect(capture.takeLastUsage()).toBeNull();
  });

  it("clears the captured usage after it is read, so a stale value is never returned twice", async () => {
    const client = fakeClient(async () => makeMockMessage("hi"));
    const capture = createUsageCapturingClient(client);

    await capture.client.messages.create({} as Anthropic.MessageCreateParamsNonStreaming);
    expect(capture.takeLastUsage()).not.toBeNull();
    expect(capture.takeLastUsage()).toBeNull();
  });

  it("still returns the real message unchanged to the original caller", async () => {
    const message = makeMockMessage("the real answer");
    const client = fakeClient(async () => message);
    const capture = createUsageCapturingClient(client);

    const result = await capture.client.messages.create({} as Anthropic.MessageCreateParamsNonStreaming);
    expect(result).toBe(message);
  });

  it("captures usage from a second call independently of the first", async () => {
    let call = 0;
    const client = fakeClient(async () => {
      call += 1;
      return makeMockMessage("hi", { usage: { ...makeMockMessage("hi").usage, input_tokens: call * 100 } });
    });
    const capture = createUsageCapturingClient(client);

    await capture.client.messages.create({} as Anthropic.MessageCreateParamsNonStreaming);
    expect(capture.takeLastUsage()?.input_tokens).toBe(100);

    await capture.client.messages.create({} as Anthropic.MessageCreateParamsNonStreaming);
    expect(capture.takeLastUsage()?.input_tokens).toBe(200);
  });
});
