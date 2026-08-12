/**
 * Processes one claimed single-label-originated `review_queue` row
 * (TRO-511, CP-3 §9/§12 open question 5): rebuilds `ResolverInput` from the
 * verify route's own snapshot, calls `resolveEscalatedLabel` (LH-014,
 * already merged — this module calls it, never re-implements its
 * pre-check or its review_queue write), and releases/retries/parks the
 * claim depending on the outcome. Also a small polling loop
 * (`startSingleLabelResolveWorker`) that drives `claimNextReviewQueueResolveItem`
 * the same way `../batch-queue/pool.ts` drives `claimNextBatchQueueItem` —
 * reusing that module's own exported loop-error-backoff helpers rather
 * than reimplementing the escalation formula a second time.
 *
 * **No batch counters, no escalation cap, no completion-guard double
 * transaction.** Unlike `../batch-queue/resolve-worker.ts`, there is no
 * `batch_queue_items` row to mark `DONE`, no `batchJobs` counters to
 * increment, no `maybeCompleteBatchJob` to check, and no per-batch Sonnet
 * call cap to reserve against (`../batch-queue/escalation-cap.ts`'s cap is
 * a fraction of a `batch_jobs.totalCount` that does not exist for a
 * single-label row — there is nothing to reuse there with the SAME
 * semantics, so this module does not invent a second, different one; see
 * this ticket's PR body for the full reasoning). The only state this
 * module owns is the `review_queue` row itself.
 *
 * **The TRO-506-shaped race is handled INSIDE `resolveEscalatedLabel`
 * itself** (`../resolver/index.ts`'s "pending" branch, TRO-511), not by a
 * catch-and-recover block here the way `resolve-worker.ts` needs one for
 * the batch path's plain-INSERT collision. `resolveEscalatedLabel` either
 * returns a `ResolverResult` (whichever caller's write actually won) or
 * throws for a genuine failure — this module's own `try`/`catch` only
 * needs to classify and react to THAT.
 */
import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import { reviewQueue } from "../../lib/db/schema";
import {
  resolveEscalatedLabel as defaultResolveEscalatedLabel,
  type ResolveEscalatedLabelOptions,
  type ResolverInput,
  type ResolverResult,
} from "../resolver";
import { classifyModelCallError, computeBackoffDelayMs, DEFAULT_BACKOFF_CONFIG, type BackoffConfig } from "../batch-queue/backoff";
import { toApplicationRecord, type ApplicationRow } from "../batch-queue/extract-worker";
import { parseResolverInputSnapshot } from "../batch-queue/resolver-snapshot";
import { resizeStoredOriginalToSonnetVariant } from "../batch-queue/image";
import { computeLoopErrorBackoffMs, LOOP_ERROR_BASE_BACKOFF_MS, LOOP_ERROR_MAX_BACKOFF_MS, type LoopErrorBackoffConfig } from "../batch-queue/pool";
import { claimNextReviewQueueResolveItem, type ClaimedReviewQueueResolveItem, type ClaimNextReviewQueueResolveItemOptions } from "./claim";

export interface SingleLabelResolveWorkerDeps {
  db: typeof defaultDb;
  readLabelImage: (storagePath: string) => Promise<Buffer>;
  resolveEscalatedLabel?: (input: ResolverInput, options?: ResolveEscalatedLabelOptions) => Promise<ResolverResult>;
  anthropicClient?: ResolveEscalatedLabelOptions["client"];
  backoffConfig: BackoffConfig;
}

export type SingleLabelResolveOutcomeLabel = "resolved" | "needs-human";

export type SingleLabelResolveClaimOutcome =
  | { kind: "done"; outcome: SingleLabelResolveOutcomeLabel }
  /** `isRateLimit` mirrors `ResolveClaimOutcome`'s own field — kept for the
   * same reason: a caller wiring this into a pool-wide cooldown later can
   * distinguish a 429 from any other retryable failure without this module
   * needing to know what a "pool" is. */
  | { kind: "retry"; delayMs: number; isRateLimit: boolean }
  | { kind: "failed"; reason: string }
  /** This worker's own claim episode was no longer current by the time it
   * tried to finish — another worker already reclaimed (and is possibly
   * still processing, or has already finished) the row. Its result is
   * discarded, not an error — same meaning as `ResolveClaimOutcome`'s
   * `"stale"`. */
  | { kind: "stale" };

function defaultDeps(): Omit<SingleLabelResolveWorkerDeps, "readLabelImage"> {
  return { db: defaultDb, backoffConfig: DEFAULT_BACKOFF_CONFIG };
}

/** Cap on the length of `last_error` actually written to the database —
 * same value and reasoning as `../batch-queue/complete.ts`'s own
 * (unexported) `MAX_LAST_ERROR_LENGTH`/`truncateLastError`: a human-facing
 * diagnostic string, not label data compared against statutory text, so
 * truncating it (rather than `resolver/input-validation.ts`'s much
 * stricter "never truncate, reject instead" rule) is the right call here. */
const MAX_LAST_ERROR_LENGTH = 2000;

function truncateLastError(message: string): string {
  if (message.length <= MAX_LAST_ERROR_LENGTH) return message;
  return `${message.slice(0, MAX_LAST_ERROR_LENGTH)}… (truncated, ${message.length} chars total)`;
}

/** The completion guard for the retry/fail paths ONLY — the SUCCESS path
 * does not need it (see `completeSuccess`'s own comment). Mirrors
 * `../batch-queue/complete.ts`'s `claimedGuard` shape: a write that
 * mutates the claim state itself (not the terminal `resolverOutput`) must
 * be conditioned on still holding the CURRENT claim episode, or a stale
 * worker's late failure-handling could clobber a different worker's live,
 * in-progress claim on the same row (the exact race `../batch-queue/claim.ts`'s
 * own module comment walks through for the analogous batch case). */
function claimedGuard(id: number, claimToken: string) {
  return and(eq(reviewQueue.id, id), eq(reviewQueue.claimToken, claimToken));
}

/** Releases a claimed row for a later retry: clears every claim field and
 * pushes `availableAt` forward by `delayMs`. `attempts` is left untouched —
 * the claim query already incremented it. */
async function releaseForRetry(db: typeof defaultDb, id: number, claimToken: string, delayMs: number): Promise<boolean> {
  const rows = await db
    .update(reviewQueue)
    .set({
      claimedBy: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      availableAt: sql`now() + (${delayMs} * interval '1 millisecond')`,
    })
    .where(claimedGuard(id, claimToken))
    .returning({ id: reviewQueue.id });
  return rows.length > 0;
}

/**
 * Permanently parks a claimed row: clears claim fields, records
 * `lastError`, and pins `attempts` at (at least) `maxAttempts`. Unlike
 * `../batch-queue/complete.ts`'s `markFailed`, there is no separate
 * `FAILED` status to set — `claimNextReviewQueueResolveItem`'s own
 * `attempts < maxAttempts` claim predicate is what stops a parked row from
 * being reclaimed forever.
 *
 * **The `attempts` write is required, not tidiness.** A NON-retryable
 * failure (a malformed snapshot, a deterministic 400 from the model) can
 * reach this function on attempt 1 — `handleFailure` never checks
 * `attempts` for that branch, only for the retryable one. Without pinning
 * `attempts` here, a row that failed non-retryably on attempt 1 would stay
 * claimable (`1 < maxAttempts`), and the next claim would repeat the exact
 * same deterministic failure — for `resolveEscalatedLabel` specifically,
 * that means paying for another real Sonnet call that is already known to
 * fail the same way, up to `maxAttempts` times, defeating the whole point
 * of classifying an error non-retryable in the first place (found in local
 * review; regression-tested below). `GREATEST`, not a plain assignment, so
 * a row already at or past `maxAttempts` (the exhausted-retryable path)
 * never has its `attempts` count LOWERED by this call.
 */
async function markPermanentlyFailed(db: typeof defaultDb, id: number, claimToken: string, lastError: string, maxAttempts: number): Promise<boolean> {
  const rows = await db
    .update(reviewQueue)
    .set({
      lastError: truncateLastError(lastError),
      claimedBy: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      attempts: sql`GREATEST(${reviewQueue.attempts}, ${maxAttempts})`,
    })
    .where(claimedGuard(id, claimToken))
    .returning({ id: reviewQueue.id });
  return rows.length > 0;
}

/** Tidiness only, run after a successful resolution: clears the claim
 * fields so a human reading the row later does not see a stale
 * `claimedBy`/an already-expired lease next to a real resolution. Not
 * guarded by `claimedGuard` — `resolverOutput` is already set by the time
 * this runs (inside `resolveEscalatedLabel`, whichever caller's write
 * actually won a TRO-506-shaped race), which permanently excludes this row
 * from `claimNextReviewQueueResolveItem`'s own predicate regardless of
 * these columns' values, so there is nothing left to race against. */
async function clearClaimFields(db: typeof defaultDb, id: number): Promise<void> {
  await db.update(reviewQueue).set({ claimedBy: null, claimToken: null, claimedAt: null, leaseExpiresAt: null }).where(eq(reviewQueue.id, id));
}

/** `claimToken` is its own required, non-nullable parameter — not read back
 * off `item.claimToken` inside this function — so the ONLY way to call
 * this is to have already narrowed it at the caller, genuinely, not via a
 * cast (found in local review: an inline `item.claimToken as string` here
 * previously did the same job with nothing to catch a future call site
 * that forgot `processSingleLabelResolveClaim`'s own null guard). */
async function handleFailure(
  db: typeof defaultDb,
  item: ClaimedReviewQueueResolveItem,
  claimToken: string,
  backoffConfig: BackoffConfig,
  error: unknown,
): Promise<SingleLabelResolveClaimOutcome> {
  const classification = classifyModelCallError(error);
  const message = error instanceof Error ? error.message : String(error);

  if (classification.retryable && item.attempts < backoffConfig.maxAttempts) {
    const delayMs = computeBackoffDelayMs(item.attempts, backoffConfig, classification.retryAfterMs);
    const guarded = await releaseForRetry(db, item.id, claimToken, delayMs);
    return guarded ? { kind: "retry", delayMs, isRateLimit: classification.isRateLimit } : { kind: "stale" };
  }

  const lastError = classification.retryable ? `${message} (exhausted after ${item.attempts} attempt(s))` : message;
  const guarded = await markPermanentlyFailed(db, item.id, claimToken, lastError, backoffConfig.maxAttempts);
  return guarded ? { kind: "failed", reason: lastError } : { kind: "stale" };
}

/**
 * Runs the resolver for one claimed single-label-originated `review_queue`
 * row and persists the outcome. Never throws for an ordinary processing
 * failure — same reasoning as `../batch-queue/resolve-worker.ts`'s own
 * `processResolveClaim`: every retryable/non-retryable/stale-lease outcome
 * is returned, not thrown, so a poll loop can move on to its next claim
 * unconditionally.
 */
export async function processSingleLabelResolveClaim(
  item: ClaimedReviewQueueResolveItem,
  deps: Partial<SingleLabelResolveWorkerDeps> & Pick<SingleLabelResolveWorkerDeps, "readLabelImage">,
): Promise<SingleLabelResolveClaimOutcome> {
  const d: SingleLabelResolveWorkerDeps = { ...defaultDeps(), ...deps };
  if (item.claimToken === null) {
    throw new Error(`processSingleLabelResolveClaim called with a malformed claim (review_queue row ${item.id}, no claimToken)`);
  }
  // Narrowed ONCE, genuinely (no cast) — `item.claimToken` reads as
  // `string` right here, immediately after the runtime check above.
  // TypeScript does not carry that narrowing across a later call to a
  // DIFFERENT function that takes `item` as a whole, so `handleFailure`
  // below takes this already-narrowed value as its own explicit parameter
  // instead of re-reading `item.claimToken` internally (found in local
  // review — see `handleFailure`'s own doc comment).
  const claimToken: string = item.claimToken;

  const parsed = parseResolverInputSnapshot(item.resolverInput);
  if (!parsed.ok) {
    return handleFailure(d.db, item, claimToken, d.backoffConfig, new Error(`resolver_input rejected: ${parsed.reason}`));
  }
  const snapshot = parsed.snapshot;
  const headlineReason = snapshot.router.headlineReason;
  if (!headlineReason) {
    // Contract violation, not a normal input — `deriveFlaggedFields`'s own
    // guarantee (via `app/api/verify/route.ts`'s only call site) means a
    // genuine REVIEW snapshot always carries one. Defensive, standing rule 13.
    return handleFailure(d.db, item, claimToken, d.backoffConfig, new Error("resolver_input.router has labelVerdict REVIEW but no headlineReason"));
  }

  let resolverInput: ResolverInput;
  try {
    const verificationRow = await d.db.query.verifications.findFirst({
      where: (v, { eq: eqOp }) => eqOp(v.id, item.verificationId),
      with: { application: true, labelImage: true },
    });
    if (!verificationRow || !verificationRow.application || !verificationRow.labelImage) {
      throw new Error(`verification ${item.verificationId} or its application/labelImage not found for review_queue row ${item.id}`);
    }
    const applicationRow: ApplicationRow = verificationRow.application;
    const labelImageRow = verificationRow.labelImage;

    const original = await d.readLabelImage(labelImageRow.storagePath);
    const sonnetVariant = await resizeStoredOriginalToSonnetVariant(original, labelImageRow.widthPx, labelImageRow.heightPx);

    resolverInput = {
      verificationId: item.verificationId,
      image: { data: sonnetVariant.buffer.toString("base64"), mediaType: "image/jpeg" },
      extraction: snapshot.extraction,
      application: toApplicationRecord(applicationRow),
      router: snapshot.router,
      flaggedFields: snapshot.flaggedFields,
    };
  } catch (error) {
    return handleFailure(d.db, item, claimToken, d.backoffConfig, error);
  }

  try {
    const result = await (d.resolveEscalatedLabel ?? defaultResolveEscalatedLabel)(resolverInput, { client: d.anthropicClient, db: d.db });
    await clearClaimFields(d.db, item.id);
    return { kind: "done", outcome: result.outcome };
  } catch (error) {
    return handleFailure(d.db, item, claimToken, d.backoffConfig, error);
  }
}

export interface SingleLabelResolveWorkerConfig {
  db: typeof defaultDb;
  workerIdPrefix: string;
  leaseSeconds: number;
  /** Number of concurrent claim+process loops. Proposed default 1 at the
   * entry-point layer (`scripts/batch-worker/run.ts`) — single-label REVIEW
   * volume is interactive-triggered, not batch-scale, so the concurrency
   * this queue needs is expected to be far lower than the batch RESOLVE
   * pool's. Configurable for the same reason every other pool size in this
   * project is (CP-3 §4.4): not measured yet. */
  concurrency: number;
  pollIntervalMs: number;
  readLabelImage: (storagePath: string) => Promise<Buffer>;
  resolveEscalatedLabel?: SingleLabelResolveWorkerDeps["resolveEscalatedLabel"];
  anthropicClient?: ResolveEscalatedLabelOptions["client"];
  backoffConfig: BackoffConfig;
  loopErrorBackoff?: LoopErrorBackoffConfig;
  onLoopError?: (error: unknown, workerId: string, consecutiveErrors: number) => void;
  /** Test-only — see `claim.ts`'s own `ClaimNextReviewQueueResolveItemOptions`
   * doc comment. Never set by the real entry point. */
  scopeToVerificationIds?: ClaimNextReviewQueueResolveItemOptions["scopeToVerificationIds"];
}

export interface SingleLabelResolveWorkerHandle {
  /** Signals every loop to stop after its CURRENT iteration — never
   * interrupts an in-flight claim+process cycle. Idempotent. */
  stop: () => void;
  /** Resolves once every loop has actually exited after `stop()`. */
  done: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts `config.concurrency` concurrent claim+process loops against the
 * single-label resolve queue. Deliberately does NOT reuse
 * `../batch-queue/pool.ts`'s `startWorkerPool` directly — that function's
 * own claim step is hard-wired to `claimNextBatchQueueItem` against
 * `batch_queue_items` (CP-3's own design, not this ticket's to restructure
 * for a table it was never built against) — but DOES reuse its exported,
 * table-agnostic loop-error-backoff formula
 * (`computeLoopErrorBackoffMs`/`LOOP_ERROR_BASE_BACKOFF_MS`/
 * `LOOP_ERROR_MAX_BACKOFF_MS`) rather than reimplementing it, and mirrors
 * its claim → cooldown-free process → idle-sleep → error-backoff shape.
 *
 * **No whole-pool rate-limit cooldown** (`../batch-queue/backoff.ts`'s
 * `PoolCooldownState`) the way `startWorkerPool` has one for CP-3 §5.3's
 * reason: that mechanism exists to stop SEVERAL concurrent loops from each
 * independently re-discovering the same exhausted Sonnet budget within the
 * same second. At this pool's proposed default concurrency of 1, there is
 * only one loop, so there is nothing to coordinate — a single loop already
 * serializes its own retries through `computeBackoffDelayMs`. Named here
 * as a real limitation if `concurrency` is ever raised well above 1, or if
 * this pool and the batch RESOLVE pool are ever run concurrently against a
 * shared, exhausted Sonnet rate limit — not measured, not built, see this
 * ticket's PR body.
 */
export function startSingleLabelResolveWorker(config: SingleLabelResolveWorkerConfig): SingleLabelResolveWorkerHandle {
  // Standing rule 13: validate at the boundary, before any loop starts.
  if (!Number.isInteger(config.concurrency) || config.concurrency <= 0) {
    throw new RangeError(`startSingleLabelResolveWorker: concurrency must be a positive integer, got ${config.concurrency}`);
  }
  if (!Number.isFinite(config.leaseSeconds) || config.leaseSeconds <= 0) {
    throw new RangeError(`startSingleLabelResolveWorker: leaseSeconds must be a finite number > 0, got ${config.leaseSeconds}`);
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
    throw new RangeError(`startSingleLabelResolveWorker: pollIntervalMs must be a finite number > 0, got ${config.pollIntervalMs}`);
  }

  let stopped = false;
  const onLoopError = config.onLoopError ?? ((error, workerId) => console.error(`[single-label-resolve] worker ${workerId} loop error:`, error));

  async function runLoop(index: number): Promise<void> {
    const workerId = `${config.workerIdPrefix}-single-label-resolve-${index}`;
    let consecutiveErrors = 0;
    while (!stopped) {
      try {
        const item = await claimNextReviewQueueResolveItem(config.db, workerId, config.leaseSeconds, config.backoffConfig.maxAttempts, {
          scopeToVerificationIds: config.scopeToVerificationIds,
        });
        if (!item) {
          consecutiveErrors = 0; // the claim path itself is healthy again
          await sleep(config.pollIntervalMs);
          continue;
        }

        await processSingleLabelResolveClaim(item, {
          db: config.db,
          readLabelImage: config.readLabelImage,
          resolveEscalatedLabel: config.resolveEscalatedLabel,
          anthropicClient: config.anthropicClient,
          backoffConfig: config.backoffConfig,
        });
        // Reset only once a FULL claim+process cycle finished without
        // throwing — same reasoning as `../batch-queue/pool.ts`'s own
        // identical comment: a "retry"/"failed"/"stale" outcome is a
        // NORMAL per-item result, not a loop-level error.
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        onLoopError(error, workerId, consecutiveErrors);
        await sleep(computeLoopErrorBackoffMs(consecutiveErrors, config.loopErrorBackoff));
      }
    }
  }

  const loops = Array.from({ length: config.concurrency }, (_, i) => runLoop(i));

  return {
    stop: () => {
      stopped = true;
    },
    done: Promise.all(loops).then(() => undefined),
  };
}

export { LOOP_ERROR_BASE_BACKOFF_MS, LOOP_ERROR_MAX_BACKOFF_MS };
