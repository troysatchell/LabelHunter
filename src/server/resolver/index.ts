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
 * judges-only-brand/class rule (`response.ts`), then files one
 * `review_queue` row (`queue.ts`) — both a `resolved` and a `needs-human`
 * outcome (see `queue.ts`'s doc comment). This is the clean async entry
 * point the single-label pipeline, the batch resolve-worker (LH-041 /
 * TRO-474), and the single-label resolve trigger (TRO-511) all call — the
 * agent-facing 5-second promise is verdict-or-flag (PRD §3.8); resolution
 * runs after and separately.
 *
 * **Reserve, then call, then fill in (TRO-506 / TRO-512, CP-3 §3.3).** The
 * first thing this function does for a verification is take an atomic
 * reservation (`reservation.ts`) — one `INSERT ... ON CONFLICT` statement
 * Postgres serializes. Exactly one caller wins it and calls Sonnet; every
 * other caller either reuses a resolution that already exists or waits for
 * the winner's. Two workers can no longer both pay for the same escalation.
 * The reservation replaced the old check-then-insert pre-check, which read
 * "no row yet" for both callers and let both of them buy a Sonnet call.
 *
 * The reservation also absorbed TRO-511's INSERT-vs-UPDATE fork: the row
 * always exists once this caller owns the reservation, whether the verify
 * route pre-filed it or this reservation created it, so the write after the
 * model call is always `updateReviewQueueEntryResolution`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildResolverRequestParams } from "./request";
import { parseResolverResponse } from "./response";
import { findExistingReviewQueueEntry, updateReviewQueueEntryResolution, type ResolverDb } from "./queue";
import { readReviewQueueReservation, releaseReviewQueueReservation, reserveReviewQueueEntry, RESERVATION_LEASE_SECONDS } from "./reservation";
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

/**
 * How long a caller that lost the reservation waits for the winner's
 * resolution before it gives up, in milliseconds. Equal to the reservation
 * lease (`RESERVATION_LEASE_SECONDS`): a waiter never gives up while the
 * reservation that blocked it could still be live, and never waits past the
 * point where it could take the reservation over itself.
 */
const DEFAULT_RESERVATION_WAIT_MS = RESERVATION_LEASE_SECONDS * 1000;

/**
 * How often a waiting caller re-reads the reservation, in milliseconds. One
 * cheap indexed read per poll (`readReviewQueueReservation`), on a unique
 * index. 500 ms is a bound on how stale a waiter's answer can be, not a
 * measured figure.
 */
const DEFAULT_RESERVATION_POLL_INTERVAL_MS = 500;

/**
 * A caller waited out its whole budget and the reservation holder never
 * produced a resolution. Its own class, not a bare `Error`, so a worker can
 * tell "the model failed" apart from "someone else is still working on
 * this" and react differently — the timeout is observable, not silent.
 */
export class ResolverReservationTimeoutError extends Error {
  readonly verificationId: number;
  readonly waitedMs: number;

  constructor(verificationId: number, waitedMs: number) {
    super(
      `resolveEscalatedLabel: another caller has held the review_queue reservation for verification ${verificationId} ` +
        `for ${waitedMs} ms without producing a resolution. This caller never called Sonnet (TRO-506 — two callers must ` +
        "never pay for one escalation).",
    );
    this.name = "ResolverReservationTimeoutError";
    this.verificationId = verificationId;
    this.waitedMs = waitedMs;
  }
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
  /** How long to wait for another caller's in-flight resolution before
   * throwing `ResolverReservationTimeoutError`. Defaults to
   * `DEFAULT_RESERVATION_WAIT_MS`. */
  reservationWaitMs?: number;
  /** How often to re-read another caller's reservation while waiting.
   * Defaults to `DEFAULT_RESERVATION_POLL_INTERVAL_MS`. */
  reservationPollIntervalMs?: number;
  /** How long this caller's own reservation holds off other callers.
   * Defaults to `RESERVATION_LEASE_SECONDS`. */
  reservationLeaseSeconds?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const waitMs = options.reservationWaitMs ?? DEFAULT_RESERVATION_WAIT_MS;
  const pollIntervalMs = options.reservationPollIntervalMs ?? DEFAULT_RESERVATION_POLL_INTERVAL_MS;
  // Standing rule 13: validate at the boundary. A non-positive poll
  // interval would spin the loop below on the database with no pause.
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError(`resolveEscalatedLabel: reservationWaitMs must be a finite number of 0 or more, got ${waitMs}.`);
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError(`resolveEscalatedLabel: reservationPollIntervalMs must be a finite number greater than 0, got ${pollIntervalMs}.`);
  }

  // Reserve BEFORE the model call (TRO-506 / TRO-512, CP-3 §3.3). One
  // caller wins; the rest reuse or wait. Nobody buys a second Sonnet call.
  const deadline = Date.now() + waitMs;
  let reservedId: number;
  let reservedUntil: Date;
  for (;;) {
    const reservation = await reserveReviewQueueEntry(
      { verificationId: input.verificationId, reason: headlineReason, leaseSeconds: options.reservationLeaseSeconds },
      options.db,
    );
    if (reservation.kind === "resolved") {
      // Another caller already finished this verification. Reuse its
      // result — the free, correct no-op an at-least-once retry deserves.
      return { ...reservation.resolverOutput, reviewQueueId: reservation.id };
    }
    if (reservation.kind === "reserved") {
      reservedId = reservation.id;
      // Keep the lease we won. Releasing requires it back, so a call that
      // outlives its lease cannot clear whoever took the row over.
      reservedUntil = reservation.reservedUntil;
      break;
    }

    // Another caller holds a live reservation and is calling Sonnet now.
    // Wait for its result. The wait is bounded, and the bound is
    // observable: it throws a named error, never returns a guess.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ResolverReservationTimeoutError(input.verificationId, waitMs);
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
    const state = await readReviewQueueReservation(input.verificationId, options.db);
    if (state.kind === "resolved") {
      return { ...state.resolverOutput, reviewQueueId: state.id };
    }
    // "free" (the holder released or its lease expired) and "held" both
    // loop: the next reservation attempt either wins the row or reports
    // the holder again.
  }

  const client = options.client ?? getDefaultResolverClient();
  const params = buildResolverRequestParams(input);

  let resolution;
  try {
    const message = await client.messages.create(params);
    resolution = parseResolverResponse(message, input.flaggedFields);
  } catch (cause) {
    // This caller owns a reservation it will never fill. Release it, so a
    // retry can take it immediately instead of waiting out the whole lease
    // behind a holder that has already failed. A release failure must not
    // replace the real error, and must not disappear either (standing rule
    // 24) — it is logged, and the model error still propagates.
    try {
      const released = await releaseReviewQueueReservation(reservedId, reservedUntil, options.db);
      if (!released) {
        // Normal, not an error: our lease expired and another caller took
        // the row over while this call was still running. Leaving its
        // reservation intact is the correct outcome.
        console.warn(`Did not release review_queue row ${reservedId}: the reservation is no longer this caller's to release.`);
      }
    } catch (releaseError) {
      console.error(`Could not release the review_queue reservation for row ${reservedId} after a failed resolver call`, releaseError);
    }
    throw cause;
  }

  const updated = await updateReviewQueueEntryResolution({ id: reservedId, resolverOutput: resolution }, options.db);
  if (updated) {
    return { ...resolution, reviewQueueId: updated.id };
  }

  // Lost the write race: this caller's reservation expired mid-call and
  // another caller both took it over and finished first. The Sonnet call
  // above is already paid for either way, but the WRITE lost, so re-read
  // the winner's row rather than erroring (queue.ts's
  // `updateReviewQueueEntryResolution` doc comment).
  const after = await findExistingReviewQueueEntry(input.verificationId, options.db);
  if (after.kind !== "resolved") {
    throw new Error(
      `resolveEscalatedLabel: lost the update race for review_queue row ${reservedId} (verification ` +
        `${input.verificationId}), but no resolved row was found on re-read (got "${after.kind}").`,
    );
  }
  return { ...after.resolverOutput, reviewQueueId: after.id };
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
export { findExistingReviewQueueEntry, insertReviewQueueEntry, insertSkippedReviewQueueEntry, updateReviewQueueEntryResolution } from "./queue";
export {
  RESERVATION_LEASE_SECONDS,
  readReviewQueueReservation,
  releaseReviewQueueReservation,
  reserveReviewQueueEntry,
} from "./reservation";
export type { ReserveReviewQueueEntryParams, ReviewQueueReservation, ReviewQueueReservationState } from "./reservation";
export type {
  ExistingReviewQueueEntry,
  InsertReviewQueueEntryParams,
  InsertSkippedReviewQueueEntryParams,
  ResolverDb,
  UpdateReviewQueueEntryResolutionParams,
} from "./queue";
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
