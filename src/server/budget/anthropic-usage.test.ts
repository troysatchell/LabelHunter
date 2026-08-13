/**
 * Tests for `anthropic-usage.ts` (TRO-482 / LH-061). Written first, per
 * PRD §6's TDD mandate.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeMockMessage } from "../extractor/test-support";
import { haikuCallCostUsd, wrapAnthropicClientForUsageCapture } from "./anthropic-usage";

function fakeClient(create: (params: unknown, options?: unknown) => Promise<Anthropic.Message>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

describe("wrapAnthropicClientForUsageCapture", () => {
  it("returns an undefined client and a null-forever reader when given undefined", async () => {
    const wrapped = wrapAnthropicClientForUsageCapture(undefined);
    expect(wrapped.client).toBeUndefined();
    expect(wrapped.takeLastUsage()).toBeNull();
  });

  it("captures real usage from a successful call without changing the result", async () => {
    const message = makeMockMessage("hello");
    const original = fakeClient(async () => message);
    const wrapped = wrapAnthropicClientForUsageCapture(original);
    expect(wrapped.client).toBeDefined();

    const result = await wrapped.client!.messages.create({} as never);
    expect(result).toBe(message); // the real response, untouched
    expect(wrapped.takeLastUsage()).toEqual(message.usage);
  });

  it("clears the captured usage after it is read once — a second read is null", async () => {
    const message = makeMockMessage("hello");
    const wrapped = wrapAnthropicClientForUsageCapture(fakeClient(async () => message));
    await wrapped.client!.messages.create({} as never);
    expect(wrapped.takeLastUsage()).not.toBeNull();
    expect(wrapped.takeLastUsage()).toBeNull();
  });

  it("does NOT mutate the original client object — safe to wrap a caller-owned fixture", async () => {
    const message = makeMockMessage("hello");
    const original = fakeClient(async () => message);
    const originalCreate = original.messages.create;
    wrapAnthropicClientForUsageCapture(original);
    expect(original.messages.create).toBe(originalCreate);
  });

  it("propagates a rejected call unchanged, and records no usage for it", async () => {
    const boom = new Error("upstream failure");
    const wrapped = wrapAnthropicClientForUsageCapture(
      fakeClient(async () => {
        throw boom;
      }),
    );
    await expect(wrapped.client!.messages.create({} as never)).rejects.toBe(boom);
    expect(wrapped.takeLastUsage()).toBeNull();
  });

  it("supports two independent wraps of two different clients without cross-talk", async () => {
    const messageA = makeMockMessage("a", { usage: { ...makeMockMessage("a").usage, input_tokens: 111 } });
    const messageB = makeMockMessage("b", { usage: { ...makeMockMessage("b").usage, input_tokens: 222 } });
    const wrappedA = wrapAnthropicClientForUsageCapture(fakeClient(async () => messageA));
    const wrappedB = wrapAnthropicClientForUsageCapture(fakeClient(async () => messageB));

    await wrappedA.client!.messages.create({} as never);
    await wrappedB.client!.messages.create({} as never);

    expect(wrappedA.takeLastUsage()?.input_tokens).toBe(111);
    expect(wrappedB.takeLastUsage()?.input_tokens).toBe(222);
  });
});

describe("haikuCallCostUsd — reuses scripts/eval/usage.ts's real pricing math, not a re-derived copy", () => {
  it("computes a real, non-zero cost from real usage figures", () => {
    const usage = makeMockMessage("hello").usage; // input_tokens: 100, output_tokens: 50
    const usd = haikuCallCostUsd(usage);
    // HAIKU_4_5_PRICING: $1/MTok in, $5/MTok out (scripts/eval/usage.ts).
    // 100 * (1/1_000_000) + 50 * (5/1_000_000) = 0.0001 + 0.00025 = 0.00035
    expect(usd).toBeCloseTo(0.00035, 8);
  });

  it("is zero for zero usage", () => {
    const usage = { ...makeMockMessage("hello").usage, input_tokens: 0, output_tokens: 0 };
    expect(haikuCallCostUsd(usage)).toBe(0);
  });
});
