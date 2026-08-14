/**
 * Tests for `anthropic-usage.ts` (TRO-482 / LH-061). Written first, per
 * PRD §6's TDD mandate.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { SONNET_5_INTRO_PRICING_CUTOFF } from "../../../scripts/eval/usage";
import { makeMockMessage } from "../extractor/test-support";
import { haikuCallCostUsd, sonnetCallCostUsd, wrapAnthropicClientForUsageCapture } from "./anthropic-usage";

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

// TRO-566 finding 1 — resolve-worker.ts needs the SAME real-cost math for
// its own Sonnet call, the way extract-worker.ts already has
// haikuCallCostUsd for Haiku.
describe("sonnetCallCostUsd — reuses scripts/eval/usage.ts's real Sonnet pricing, time-aware", () => {
  it("computes a real, non-zero cost at the INTRO rate for a call measured before the cutoff", () => {
    const usage = { ...makeMockMessage("hello").usage, input_tokens: 1000, output_tokens: 500 };
    const before = new Date(SONNET_5_INTRO_PRICING_CUTOFF.getTime() - 1000);
    // SONNET_5_INTRO_PRICING: $2/MTok in, $10/MTok out.
    // 1000 * (2/1_000_000) + 500 * (10/1_000_000) = 0.002 + 0.005 = 0.007
    expect(sonnetCallCostUsd(usage, before)).toBeCloseTo(0.007, 8);
  });

  it("computes the higher STANDARD rate for a call measured after the intro cutoff", () => {
    const usage = { ...makeMockMessage("hello").usage, input_tokens: 1000, output_tokens: 500 };
    const after = new Date(SONNET_5_INTRO_PRICING_CUTOFF.getTime() + 1000);
    // SONNET_5_STANDARD_PRICING: $3/MTok in, $15/MTok out.
    // 1000 * (3/1_000_000) + 500 * (15/1_000_000) = 0.003 + 0.0075 = 0.0105
    expect(sonnetCallCostUsd(usage, after)).toBeCloseTo(0.0105, 8);
  });

  it("is zero for zero usage", () => {
    const usage = { ...makeMockMessage("hello").usage, input_tokens: 0, output_tokens: 0 };
    expect(sonnetCallCostUsd(usage, new Date())).toBe(0);
  });

  it("defaults to now when no measurement time is given", () => {
    const usage = { ...makeMockMessage("hello").usage, input_tokens: 100, output_tokens: 50 };
    expect(sonnetCallCostUsd(usage)).toBeGreaterThan(0);
  });
});
