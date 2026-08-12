/**
 * Real, per-call Anthropic usage capture for the runtime budget guard
 * (TRO-482 / LH-061, PRD §8). Reuses the SAME cost-computation math the
 * eval harness already built (`../../../scripts/eval/usage.ts` —
 * `buildMeasuredCost`/`HAIKU_4_5_PRICING`), rather than re-deriving
 * per-token pricing a second time in a second place where it could drift.
 * That file's own header comment: "Neither `extractLabel` nor
 * `resolveEscalatedLabel` returns token usage to its own caller." This
 * module solves the same problem the eval harness solved
 * (`createUsageCapturingClient`), but for THIS process's concurrency
 * shape, not that harness's.
 *
 * **Why this file does not just import `createUsageCapturingClient`.**
 * That wrapper mutates ONE shared client instance in place and enforces
 * "one call at a time" with a module-level `callInFlight` flag — correct
 * for the eval harness's own serial runner, wrong here: this app's shared
 * default Anthropic client (`getDefaultExtractorClient()`,
 * `../extractor/index.ts`) is one long-lived singleton multiple concurrent
 * HTTP requests can call at once. Wrapping THAT singleton with a
 * reentrancy guard would make one in-flight verify request fail a
 * DIFFERENT, unrelated concurrent request's call. `wrapAnthropicClientForUsageCapture`
 * below is non-mutating (returns a NEW client-shaped object; the original
 * is untouched) and carries no shared/global state — each call site builds
 * its own fresh, request-scoped wrapper around its own fresh, request-
 * scoped client instance (see `../../app/api/verify/route.ts`), so there is
 * nothing to race.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { buildMeasuredCost, HAIKU_4_5_PRICING } from "../../../scripts/eval/usage";
import { HAIKU_EXTRACTOR_MODEL } from "../extractor";

export interface AnthropicUsageCapture {
  /** The same shape as the client passed in, safe to hand to `extractLabel`'s
   * own `options.client` — `undefined` in, `undefined` out (nothing to
   * wrap, nothing to capture; callers fall back to their normal default). */
  readonly client: Anthropic | undefined;
  /** Returns the most recently captured call's usage and clears it, so a
   * stale read from an earlier call can never be mistaken for a fresh one —
   * same discipline as `scripts/eval/usage.ts`'s own `takeLastUsage`. */
  takeLastUsage: () => Anthropic.Usage | null;
}

/**
 * Wraps an Anthropic client so its caller can read the real `usage` off
 * whatever call `client.messages.create` makes next, without changing that
 * call's request or response in any way. Non-mutating: builds a NEW object
 * that spreads `client`/`client.messages` and only replaces `create` —
 * the ORIGINAL object passed in is never modified, so it stays safe to
 * reuse elsewhere (a shared test fixture, a caller-owned client) even
 * after this function has wrapped it once.
 *
 * `client: undefined` in (the normal shape when a caller has not injected
 * a test double) returns `{ client: undefined, takeLastUsage: () => null }` —
 * transparent no-op, never a thrown error.
 */
export function wrapAnthropicClientForUsageCapture(client: Anthropic | undefined): AnthropicUsageCapture {
  if (!client) {
    return { client: undefined, takeLastUsage: () => null };
  }
  let lastUsage: Anthropic.Usage | null = null;
  const boundCreate = client.messages.create.bind(client.messages);
  const wrapped = {
    ...client,
    messages: {
      ...client.messages,
      create: (async (params: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions) => {
        const result = await boundCreate(params, options);
        lastUsage = (result as Anthropic.Message).usage ?? null;
        return result;
      }) as Anthropic["messages"]["create"],
    },
  } as Anthropic;
  return {
    client: wrapped,
    takeLastUsage: () => {
      const usage = lastUsage;
      lastUsage = null;
      return usage;
    },
  };
}

/** Real USD cost of one Haiku extraction call, from its real, measured
 * `Anthropic.Usage` — `buildMeasuredCost` and `HAIKU_4_5_PRICING` are the
 * SAME published-price formula `scripts/eval/usage.ts` uses for the eval
 * harness's own committed cost evidence (CLAUDE.md: never fabricate a
 * number). `HAIKU_EXTRACTOR_MODEL` (`../extractor`) is this repo's one
 * source of truth for the model id string, so this never drifts from what
 * the extractor actually calls. */
export function haikuCallCostUsd(usage: Anthropic.Usage): number {
  return buildMeasuredCost(HAIKU_EXTRACTOR_MODEL, usage, HAIKU_4_5_PRICING).usd;
}
