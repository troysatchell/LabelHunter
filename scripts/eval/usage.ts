/**
 * Real, measured API cost for the eval harness (LH-030 / TRO-470).
 * CLAUDE.md: never fabricate a number.
 *
 * Neither `extractLabel` nor `resolveEscalatedLabel` returns token usage to
 * its own caller. Both discard it after parsing the response body.
 * `createUsageCapturingClient` wraps a real `Anthropic` client so this
 * harness can still read each call's real `response.usage`, with no second
 * call. `computeCostUsd` multiplies that real usage by Anthropic's
 * published per-token price. The price is a known public rate. The token
 * count is always a real measurement. Neither input is invented.
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

/** `claude-sonnet-5`'s INTRO rate ($2/$10 per MTok) — active only through
 * `SONNET_5_INTRO_PRICING_CUTOFF` (PRD §4). Use `selectSonnetPricing`, not
 * this constant directly, so a run after the cutoff prices correctly
 * instead of silently keeping the intro rate. */
export const SONNET_5_INTRO_PRICING: TokenPricing = { inputPerToken: 2 / 1_000_000, outputPerToken: 10 / 1_000_000 };

/** `claude-sonnet-5`'s standard rate ($3/$15 per MTok), effective the
 * instant the intro window closes (PRD §4). */
export const SONNET_5_STANDARD_PRICING: TokenPricing = { inputPerToken: 3 / 1_000_000, outputPerToken: 15 / 1_000_000 };

/** The last instant PRD §4's Sonnet 5 intro rate applies. `2026-08-31`
 * (PRD §4) means the whole day in UTC — this is that day's final
 * millisecond, so `measuredAt <= this` correctly includes it. */
export const SONNET_5_INTRO_PRICING_CUTOFF = new Date("2026-08-31T23:59:59.999Z");

/**
 * Picks the correct Sonnet 5 pricing for a run, by when it ran — never a
 * hard-coded constant a caller could use past its own expiry date. `at
 * <= SONNET_5_INTRO_PRICING_CUTOFF` uses the intro rate; anything after
 * uses the standard rate. Accepts a `Date` or an ISO string (an
 * `EvalReport.measuredAt` value, read back from a committed JSON file, is
 * always a string).
 */
export function selectSonnetPricing(at: Date | string): TokenPricing {
  const measuredAt = typeof at === "string" ? new Date(at) : at;
  return measuredAt.getTime() <= SONNET_5_INTRO_PRICING_CUTOFF.getTime() ? SONNET_5_INTRO_PRICING : SONNET_5_STANDARD_PRICING;
}

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
  /** Returns the pending call's usage and clears it, so a second read
   * without an intervening call returns `null` rather than a stale value —
   * a caller that reads twice by mistake gets a loud "nothing happened"
   * signal, not a silently duplicated cost. */
  takeLastUsage(): Anthropic.Usage | null;
}

/**
 * Wraps `underlying.messages.create` to capture each response's `usage`.
 *
 * ONE CALL AT A TIME, ENFORCED, NOT ASSUMED. `lastUsage` is one mutable
 * slot shared by every call this wrapped client makes. Two overlapping
 * `create` calls on the SAME wrapped client would race on that slot — the
 * second call's usage could silently overwrite or be overwritten by the
 * first, misattributing real cost between two different requests (a PR
 * review finding, not a hypothetical). Rather than accept that risk
 * silently, the wrapper below throws if a second call starts before the
 * first one's usage has been read: every caller in this ticket already
 * constructs one client per logical call and awaits it before starting the
 * next (`cascade-runner.ts`, `benchmark.ts`) — this makes a future caller
 * that breaks that rule fail loudly instead of producing a quietly wrong
 * number.
 *
 * Mutates `underlying` in place (`underlying.messages.create` is
 * reassigned) — callers MUST pass a client instance dedicated to this
 * wrapper alone, never a shared default client another part of the harness
 * also calls.
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
  let callInFlight = false;
  const originalCreate = underlying.messages.create.bind(underlying.messages);

  underlying.messages.create = (async (
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Anthropic.Message> => {
    if (callInFlight) {
      throw new Error(
        "createUsageCapturingClient: a second messages.create call started before the first one's usage was " +
          "read — this wrapper supports exactly one call at a time per client instance. Construct a dedicated " +
          "client per logical call instead of sharing one across concurrent requests.",
      );
    }
    callInFlight = true;
    try {
      const result = (await originalCreate(params, options)) as Anthropic.Message;
      lastUsage = result.usage;
      return result;
    } finally {
      callInFlight = false;
    }
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
