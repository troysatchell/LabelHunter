/**
 * Real, measured API cost for the eval harness (LH-030 / TRO-470,
 * CLAUDE.md: "never fabricate a number").
 *
 * Two halves:
 *
 *   - `createUsageCapturingClient` wraps a real `Anthropic` client so every
 *     call's `response.usage` — real token counts the API itself reports —
 *     is captured, since neither `extractLabel` nor `resolveEscalatedLabel`
 *     surfaces `usage` to their own caller (both discard it after parsing
 *     the response body). This is the same "capture through an injected
 *     dependency" pattern `scripts/latency/measure.ts` already uses for
 *     `saveLabelImage`, applied one layer deeper — the Anthropic client
 *     itself, not the function that calls it.
 *   - `computeCostUsd` multiplies real, measured token counts by Anthropic's
 *     PUBLISHED per-token price. The price is a known public rate, not a
 *     measurement; the token count it multiplies always comes from a real
 *     API response. Neither half is invented.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { MeasuredCost } from "./types";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

export interface TokenPricing {
  readonly inputPerToken: number;
  readonly outputPerToken: number;
}

/**
 * Published Anthropic per-token pricing, USD (`shared/live-sources.md`'s
 * cached pricing table; matches `docs/PRD.md` §4's own committed cost
 * table). Neither model's request builders in this repo set
 * `cache_control` (confirmed by reading `src/server/extractor/request.ts`
 * and `src/server/resolver/request.ts`) — `computeCostUsd` still prices the
 * cache token fields, at their own published rate, so a real
 * `cache_creation_input_tokens`/`cache_read_input_tokens` reading is never
 * silently dropped from the total if that ever changes.
 */
export const HAIKU_4_5_PRICING: TokenPricing = { inputPerToken: 1 / 1_000_000, outputPerToken: 5 / 1_000_000 };

/**
 * `claude-sonnet-5`'s INTRO rate ($2/$10 per MTok), active through
 * 2026-08-31 per `docs/PRD.md` §4 — this eval run's own `measuredAt` date
 * falls inside that window. The standard rate ($3/$15) applies after the
 * intro window closes; this constant is not date-aware and will read the
 * wrong number for a run after 2026-08-31, a known, accepted limitation for
 * this ticket's scope (re-measure, don't silently keep using this constant,
 * once the intro window closes).
 */
export const SONNET_5_INTRO_PRICING: TokenPricing = { inputPerToken: 2 / 1_000_000, outputPerToken: 10 / 1_000_000 };

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Computes real USD cost from real, measured token usage and a published
 * per-token price. Pure. */
export function computeCostUsd(usage: TokenUsage, pricing: TokenPricing): number {
  return (
    usage.inputTokens * pricing.inputPerToken +
    usage.outputTokens * pricing.outputPerToken +
    usage.cacheCreationInputTokens * pricing.inputPerToken * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadInputTokens * pricing.inputPerToken * CACHE_READ_MULTIPLIER
  );
}

/** Builds one `MeasuredCost` record from a real `Anthropic.Usage`. `usage`
 * must be non-null — a call that happened always gets a `usage` object back
 * from the API; a caller with no `usage` because no call happened should
 * never reach for this function at all (see `CascadeCaseResult.resolverCost`'s
 * own `| null`, which represents exactly that case one level up). */
export function buildMeasuredCost(model: string, usage: Anthropic.Usage, pricing: TokenPricing): MeasuredCost {
  const tokenUsage = toTokenUsage(usage);
  return { model, ...tokenUsage, usd: computeCostUsd(tokenUsage, pricing) };
}

export interface UsageCapturingClient {
  /** The same object passed in, mutated in place — see this function's own
   * doc comment for the "dedicated instance" requirement. */
  readonly client: Anthropic;
  /** Returns the most recent call's usage and clears it, so a second read
   * without an intervening call returns `null` rather than a stale value —
   * a caller that reads twice by mistake gets a loud "nothing happened"
   * signal, not a silently duplicated cost. */
  takeLastUsage(): Anthropic.Usage | null;
}

/**
 * Wraps `underlying.messages.create` to capture each response's `usage`.
 * Mutates `underlying` in place (`underlying.messages.create` is
 * reassigned) — callers MUST pass a client instance dedicated to this
 * wrapper alone, never a shared default client another part of the harness
 * also calls, or usage from an unrelated call could be attributed to the
 * wrong one.
 *
 * Only wraps the non-streaming `create` overload — the one shape this
 * repo's own callers use (`extractLabel`, `resolveEscalatedLabel`; neither
 * streams). The cast at the end is the same "fake client" shape this repo's
 * own tests already use (`src/server/extractor/index.test.ts`,
 * `src/server/resolver/index.test.ts`: `{ messages: { create: ... } } as
 * unknown as Anthropic`) — wrapping the one method every real caller here
 * uses, not reproducing the SDK's full overloaded surface.
 */
export function createUsageCapturingClient(underlying: Anthropic): UsageCapturingClient {
  let lastUsage: Anthropic.Usage | null = null;
  const originalCreate = underlying.messages.create.bind(underlying.messages);

  underlying.messages.create = (async (
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Anthropic.Message> => {
    const result = (await originalCreate(params, options)) as Anthropic.Message;
    lastUsage = result.usage;
    return result;
  }) as typeof underlying.messages.create;

  return {
    client: underlying,
    takeLastUsage: () => {
      const usage = lastUsage;
      lastUsage = null;
      return usage;
    },
  };
}
