/**
 * The Sonnet resolver (LH-014 / TRO-464, PRD §3.1/§3.3, CP-1 §6).
 *
 * Public entry point: `resolveEscalatedLabel(input)`. It answers a narrow
 * question for the fields the Validation Router (LH-012/LH-013) could not
 * decide: what should the verdict be? It never runs on a label the router
 * passed (TH-R19 — the cascade is the architecture, not an optimization) —
 * `resolveEscalatedLabel` refuses at runtime, not just by convention, when
 * `input.router.labelVerdict !== "REVIEW"`.
 *
 * One call per escalated label: builds the request (`request.ts`), calls
 * the model, parses and validates the response while enforcing the
 * judges-only-brand/class rule (`response.ts`), then inserts one
 * `review_queue` row (`queue.ts`) — both a `resolved` and a `needs-human`
 * outcome insert (see `queue.ts`'s doc comment). This is the clean async
 * entry point the pipeline (LH-015/LH-016, sibling branches) and the future
 * batch worker call — the agent-facing 5-second promise is verdict-or-flag
 * (PRD §3.8); resolution runs after and separately.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildResolverRequestParams } from "./request";
import { parseResolverResponse } from "./response";
import { insertReviewQueueEntry, type ResolverDb } from "./queue";
import type { ResolverInput, ResolverResult } from "./types";

/**
 * Request timeout for the shared default client, in milliseconds. Same
 * reasoning as `../extractor/index.ts`'s `DEFAULT_CLIENT_TIMEOUT_MS`, sized
 * up: a resolver call carries a larger image and adaptive thinking, so it
 * is expected (not measured, CP-1 §7.3) to run longer than an extraction.
 */
const DEFAULT_CLIENT_TIMEOUT_MS = 60_000;

/**
 * Retry count for the shared default client. 0, not the SDK's default of 2
 * — same reasoning as the extractor's `DEFAULT_CLIENT_MAX_RETRIES`: an
 * SDK-level retry would stack silently underneath the batch worker's own
 * backoff (CP-3, not built yet) instead of being one policy in one place.
 */
const DEFAULT_CLIENT_MAX_RETRIES = 0;

let defaultClient: Anthropic | undefined;

/** The shared default Anthropic client `resolveEscalatedLabel` uses when no
 * client is injected. Constructed once and reused, same pattern as
 * `../extractor/index.ts`'s `getDefaultExtractorClient`. Reads
 * `ANTHROPIC_API_KEY` from the environment; never hard-coded. */
export function getDefaultResolverClient(): Anthropic {
  if (!defaultClient) {
    defaultClient = new Anthropic({
      timeout: DEFAULT_CLIENT_TIMEOUT_MS,
      maxRetries: DEFAULT_CLIENT_MAX_RETRIES,
    });
  }
  return defaultClient;
}

export class ResolverNotEscalatedError extends Error {
  constructor(labelVerdict: string) {
    super(
      `resolveEscalatedLabel was called with labelVerdict "${labelVerdict}", not "REVIEW". ` +
        "The resolver never runs on a label the router did not escalate (TH-R19) — this is a caller bug, not a model failure.",
    );
    this.name = "ResolverNotEscalatedError";
  }
}

export interface ResolveEscalatedLabelOptions {
  /** Anthropic client to use. Defaults to the shared client from
   * `getDefaultResolverClient()`. Inject a client with a mocked
   * `messages.create` in tests; the unit suite never calls the real API. */
  client?: Anthropic;
  /** Drizzle database handle to use. Defaults to the shared `db` singleton.
   * Inject a test database (this worktree's own, via `.factory-env`) or a
   * mock in tests. */
  db?: ResolverDb;
}

/**
 * Resolves one escalated label's flagged fields with Sonnet, then files the
 * result in the review queue. Throws `ResolverNotEscalatedError` if
 * `input.router.labelVerdict` is not `"REVIEW"`, and throws if
 * `input.flaggedFields` is empty — both defend TH-R19 at the boundary,
 * independent of whatever calls this function.
 */
export async function resolveEscalatedLabel(
  input: ResolverInput,
  options: ResolveEscalatedLabelOptions = {},
): Promise<ResolverResult> {
  if (input.router.labelVerdict !== "REVIEW") {
    throw new ResolverNotEscalatedError(input.router.labelVerdict);
  }
  if (input.flaggedFields.length === 0) {
    throw new Error("resolveEscalatedLabel was called with an empty flaggedFields list — nothing to resolve.");
  }
  const headlineReason = input.router.headlineReason;
  if (!headlineReason) {
    // Contract violation, not a normal input: LabelRouterResult only omits
    // headlineReason on a clean PASS (`../router/types.ts`), and the guard
    // above already rejected anything but REVIEW.
    throw new Error("resolveEscalatedLabel: router result has labelVerdict REVIEW but no headlineReason.");
  }

  const client = options.client ?? getDefaultResolverClient();
  const params = buildResolverRequestParams(input);
  const message = await client.messages.create(params);
  const resolution = parseResolverResponse(message, input.flaggedFields);

  const { id: reviewQueueId } = await insertReviewQueueEntry(
    {
      verificationId: input.verificationId,
      reason: headlineReason,
      resolverOutput: resolution,
    },
    options.db,
  );

  return { ...resolution, reviewQueueId };
}

export { SONNET_RESOLVER_MODEL, buildResolverRequestParams } from "./request";
export { SYSTEM_PROMPT } from "./prompt";
export { RESOLVER_JSON_SCHEMA } from "./schema";
export { serializeUntrusted } from "./serialize";
export { buildUserMessageText } from "./user-message";
export {
  ResolverInputError,
  assertUntrustedInputWithinBounds,
  SHORT_FIELD_MAX_LENGTH,
  LONG_FIELD_MAX_LENGTH,
} from "./input-validation";
export {
  ResolverResponseError,
  parseResolverResponse,
  validateResolverResult,
  deriveResolvedFields,
} from "./response";
export { toJudgedFieldResultRow } from "./field-result";
export { insertReviewQueueEntry } from "./queue";
export type { ResolverDb, InsertReviewQueueEntryParams } from "./queue";
export type {
  ApplicationRecord,
  CorrectionFieldResolution,
  FlaggedField,
  JudgedFieldResolution,
  LabelRouterResult,
  RawResolverField,
  RawResolverResponse,
  ResolvedFieldResult,
  ResolverCorrectionField,
  ResolverDisposition,
  ResolverField,
  ResolverInput,
  ResolverJudgedField,
  ResolverOutcome,
  ResolverResolution,
  ResolverResult,
  ReviewReason,
  RouterFieldKey,
} from "./types";
