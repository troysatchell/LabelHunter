/**
 * Processes one claimed `RESOLVE` queue row (CP-3 §2.3, §3.3, §6, §8 step
 * 6). It rebuilds `ResolverInput` from the `EXTRACT` worker's snapshot,
 * reserves the batch's Sonnet budget, calls `resolveEscalatedLabel`, and
 * persists the outcome. It never re-implements that resolver.
 *
 * **The completion guard runs in its own transaction, after the resolver
 * call, not around it.** The resolver commits its own `review_queue`
 * insert independently. Holding a transaction open across a live network
 * call is worse than the two-step shape here, and CP-3 §8 step 6 describes
 * this same ordering.
 *
 * **Daily budget.** It reserves `SONNET_CALL_RESERVE_ESTIMATE_USD` after
 * the escalation-cap reservation succeeds and before the resolver call,
 * then settles to the measured cost — or refunds in full when the call
 * reused another caller's finished result.
 *
 * That order has an accepted cost: a budget-blocked attempt still counts
 * against the escalation cap. Checking dollars first would need a give-back
 * path in `escalation-cap.ts`, which is more surface for a marginal gain —
 * the cap bounds a cost heuristic, not a hard limit (PRD §3.7).
 */
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import { batchJobs, verifications } from "../../lib/db/schema";
import {
  BudgetExhaustedError,
  reserveDailyBudget,
  settleBudgetReservation,
  SONNET_CALL_RESERVE_ESTIMATE_USD,
  type BudgetReservation,
} from "../budget/daily-budget";
import { sonnetCallCostUsd, wrapAnthropicClientForUsageCapture } from "../budget/anthropic-usage";
import {
  getDefaultResolverClient,
  resolveEscalatedLabel as defaultResolveEscalatedLabel,
  insertSkippedReviewQueueEntry,
  type ResolveEscalatedLabelOptions,
  type ResolverInput,
  type ResolverResult,
} from "../resolver";
import { classifyModelCallError, computeBackoffDelayMs, DEFAULT_BACKOFF_CONFIG, type BackoffConfig } from "./backoff";
import type { ClaimedBatchQueueItem } from "./claim";
import { markDone, markFailed, maybeCompleteBatchJob, releaseForRetry } from "./complete";
import { toApplicationRecord, type ApplicationRow } from "./extract-worker";
import { computeSonnetCallCapThreshold, ESCALATION_CAP_EXCEEDED_SKIP_REASON, reserveSonnetCall } from "./escalation-cap";
import { resizeStoredOriginalToSonnetVariant } from "./image";
import { parseResolverInputSnapshot } from "./resolver-snapshot";

export interface ResolveWorkerDeps {
  db: typeof defaultDb;
  readLabelImage: (storagePath: string) => Promise<Buffer>;
  resolveEscalatedLabel?: (input: ResolverInput, options?: ResolveEscalatedLabelOptions) => Promise<ResolverResult>;
  anthropicClient?: ResolveEscalatedLabelOptions["client"];
  backoffConfig: BackoffConfig;
  /** TRO-566 finding 1 — see this file's header comment. Optional, with an
   * always-reserve fallback (`ALLOW_ALL_RESERVATION`) inside
   * `processResolveClaim` itself, the same shape/reasoning as
   * `extract-worker.ts`'s own `reserveBudget`. `defaultDeps()` below binds
   * the REAL, DB-backed function, so production (via
   * `scripts/batch-worker/run.ts`, which does not override this field)
   * gets real enforcement without any change to that entry point. */
  reserveBudget?: (estimatedUsd: number) => Promise<BudgetReservation>;
  /** TRO-566 finding 1 — see `extract-worker.ts`'s matching field for the
   * full reasoning. */
  settleBudget?: (reservedUsd: number, realUsd: number) => Promise<void>;
}

export type ResolveOutcomeLabel = "resolved" | "needs-human" | "cap-skipped";

export type ResolveClaimOutcome =
  | { kind: "done"; outcome: ResolveOutcomeLabel }
  /** See `ExtractClaimOutcome`'s matching comment — `isRateLimit` drives
   * `pool.ts`'s whole-pool cooldown (CP-3 §5.3). `isBudgetExhausted`
   * (TRO-566) is the same kind of pool-wide signal for a different cause. */
  | { kind: "retry"; delayMs: number; isRateLimit: boolean; isBudgetExhausted?: boolean }
  | { kind: "failed"; reason: string }
  | { kind: "stale" };

/** Used only when a caller's `deps` does not set `reserveBudget` — see
 * `extract-worker.ts`'s matching constant for the full reasoning. */
const ALLOW_ALL_RESERVATION: BudgetReservation = { reserved: true, reservedUsd: 0, spentUsd: 0, budgetUsd: 0 };

/** Used only when a caller's `deps` does not set `settleBudget`. */
async function noopSettleBudget(): Promise<void> {}

/** Settles a reservation, logging (never throwing) a write failure — same
 * best-effort posture as `extract-worker.ts`'s own `settleReservationBestEffort`. */
async function settleReservationBestEffort(
  settleBudget: ResolveWorkerDeps["settleBudget"],
  reservedUsd: number,
  realUsd: number,
): Promise<void> {
  try {
    await (settleBudget ?? noopSettleBudget)(reservedUsd, realUsd);
  } catch (cause) {
    console.error("Could not settle a daily-budget reservation for a batch RESOLVE item", cause);
  }
}

function defaultDeps(): Omit<ResolveWorkerDeps, "readLabelImage"> {
  return {
    db: defaultDb,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
    // TRO-566 — real, DB-backed by default; see extract-worker.ts's own
    // matching comment for why this is the safe production shape.
    reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, defaultDb),
    settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, defaultDb),
    // TRO-566 — real evidence (a live-API observed run) caught this
    // missing: without it, `d.anthropicClient` stays `undefined` in
    // production, `resolveEscalatedLabel` still calls the real API
    // (falling back to its OWN shared default client), but this worker's
    // usage capture never sees that call and always refunds the FULL
    // reservation even after a genuine call. See `extract-worker.ts`'s
    // matching `anthropicClient` getter for the full reasoning — same
    // fix, same bug shape, this module's own Sonnet client.
    get anthropicClient(): ResolveEscalatedLabelOptions["client"] {
      return getDefaultResolverClient();
    },
  };
}

/**
 * `code`/`constraint` are `pg`'s own `DatabaseError` fields. Verified
 * empirically (not assumed — `resolve-worker.test.ts`'s own TRO-506 case
 * caught this): Drizzle's node-postgres driver does NOT throw that error
 * directly — it wraps it in its own `DrizzleQueryError`, with the real `pg`
 * error underneath as `.cause` (`drizzle-orm/errors.js`). This checks both
 * the caught error itself and one level of `.cause`, so it recognizes a
 * unique violation regardless of which layer's shape changes first.
 *
 * `constraintName`, when given, is checked leniently: a caller that cannot
 * see a `.constraint` (some error-verbosity settings omit it) still counts
 * as a match on `code` alone, rather than silently falling through to "not
 * a unique violation" for a genuine one.
 */
function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  const matches = (candidate: unknown): boolean => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const e = candidate as { code?: unknown; constraint?: unknown };
    if (e.code !== "23505") return false;
    if (constraintName && e.constraint !== undefined && e.constraint !== constraintName) return false;
    return true;
  };
  if (matches(error)) return true;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return matches((error as { cause?: unknown }).cause);
  }
  return false;
}

type ReviewQueueWinningOutcome = { kind: "resolved"; disposition: "resolved" | "needs-human" } | { kind: "skipped" };

/**
 * Reads back who won a `review_queue_verification_id_unique` race, after
 * THIS caller's own insert attempt lost it — either `resolveEscalatedLabel`'s
 * real insert (the TRO-506 shape, CP-3 §3.3) or this module's own
 * `insertSkippedReviewQueueEntry` (a symmetrical race this design adds:
 * one worker's real resolution colliding with another's cap-skip marker,
 * or two cap-skips colliding, both reachable under the SAME lease-expiry
 * double-claim §3.3 already names). Does not reuse
 * `findExistingReviewQueueEntry`'s strict `ResolverResolution` validator —
 * that function is deliberately paranoid for a different purpose (handing
 * a fully-typed result back to a caller expecting one); this only needs
 * the coarse fact of which counter and `resolutionPath` outcome apply.
 */
async function readReviewQueueOutcome(db: typeof defaultDb, verificationId: number): Promise<ReviewQueueWinningOutcome> {
  const row = await db.query.reviewQueue.findFirst({ where: (rq, { eq }) => eq(rq.verificationId, verificationId) });
  if (!row) {
    throw new Error(`expected an existing review_queue row for verification ${verificationId} after a unique-constraint collision; found none.`);
  }
  if (row.resolverSkipReason !== null) return { kind: "skipped" };
  const output = row.resolverOutput as { outcome?: unknown } | null;
  if (output && typeof output === "object" && (output.outcome === "resolved" || output.outcome === "needs-human")) {
    return { kind: "resolved", disposition: output.outcome };
  }
  throw new Error(`review_queue row ${row.id} for verification ${verificationId} has neither a resolverSkipReason nor a recognizable resolverOutput.outcome.`);
}

interface CompletionPlan {
  setResolverPath: boolean;
  counterKey: "resolvedBySonnetCount" | "needsHumanCount";
  outcome: ResolveOutcomeLabel;
}

function planFromWinningOutcome(winning: ReviewQueueWinningOutcome): CompletionPlan {
  if (winning.kind === "skipped") {
    return { setResolverPath: false, counterKey: "needsHumanCount", outcome: "cap-skipped" };
  }
  return {
    setResolverPath: true,
    counterKey: winning.disposition === "resolved" ? "resolvedBySonnetCount" : "needsHumanCount",
    outcome: winning.disposition,
  };
}

/** Guarded completion: marks the `RESOLVE` item `DONE`, conditionally
 * updates `verifications.resolutionPath`, increments the right counter,
 * and checks whether the batch just finished — all in one transaction
 * (CP-3 §3.2, §8 step 6). */
async function completeResolveItem(db: typeof defaultDb, item: ClaimedBatchQueueItem, plan: CompletionPlan): Promise<ResolveClaimOutcome> {
  const guarded = await db.transaction(async (tx) => {
    const ok = await markDone(tx, item.id, item.claimToken as string);
    if (!ok) return false;
    if (plan.setResolverPath) {
      await tx.update(verifications).set({ resolutionPath: "EXTRACTOR_RESOLVER" }).where(sql`${verifications.id} = ${item.verificationId}`);
    }
    const counterColumn = plan.counterKey === "resolvedBySonnetCount" ? batchJobs.resolvedBySonnetCount : batchJobs.needsHumanCount;
    await tx
      .update(batchJobs)
      .set({ [plan.counterKey]: sql`${counterColumn} + 1` })
      .where(sql`${batchJobs.id} = ${item.batchJobId}`);
    await maybeCompleteBatchJob(tx, item.batchJobId);
    return true;
  });
  return guarded ? { kind: "done", outcome: plan.outcome } : { kind: "stale" };
}

/** Releases (retryable, under maxAttempts) or permanently fails (§5.1/§5.2)
 * a claimed RESOLVE item. Only `failedCount` increments on permanent
 * failure — `processedCount` was already incremented when this label's
 * `EXTRACT` item reached `DONE` (CP-3 §7.1's own table — counting it again
 * here would double-count one label). */
async function handleResolveFailure(
  db: typeof defaultDb,
  item: ClaimedBatchQueueItem,
  backoffConfig: BackoffConfig,
  error: unknown,
): Promise<ResolveClaimOutcome> {
  const classification = classifyModelCallError(error);
  const message = error instanceof Error ? error.message : String(error);

  if (classification.retryable && item.attempts < backoffConfig.maxAttempts) {
    const delayMs = computeBackoffDelayMs(item.attempts, backoffConfig, classification.retryAfterMs);
    const guarded = await releaseForRetry(db, item.id, item.claimToken as string, delayMs);
    return guarded
      ? { kind: "retry", delayMs, isRateLimit: classification.isRateLimit, isBudgetExhausted: classification.isBudgetExhausted }
      : { kind: "stale" };
  }

  const lastError = classification.retryable ? `${message} (exhausted after ${item.attempts} attempt(s))` : message;
  const guarded = await db.transaction(async (tx) => {
    const ok = await markFailed(tx, item.id, item.claimToken as string, lastError);
    if (!ok) return false;
    await tx.update(batchJobs).set({ failedCount: sql`${batchJobs.failedCount} + 1` }).where(sql`${batchJobs.id} = ${item.batchJobId}`);
    await maybeCompleteBatchJob(tx, item.batchJobId);
    return true;
  });
  return guarded ? { kind: "failed", reason: lastError } : { kind: "stale" };
}

/** The cap-exhausted path (CP-3 §6.2): no Sonnet call, a skip-marker
 * `review_queue` row instead. Symmetrically races against
 * `resolveEscalatedLabel`'s own insert the same way §3.3 requires for a
 * real call — see the module comment on `readReviewQueueOutcome`. */
async function completeCapSkip(
  db: typeof defaultDb,
  item: ClaimedBatchQueueItem,
  headlineReason: NonNullable<ResolverInput["router"]["headlineReason"]>,
  backoffConfig: BackoffConfig,
): Promise<ResolveClaimOutcome> {
  let plan: CompletionPlan;
  try {
    try {
      await insertSkippedReviewQueueEntry(
        { verificationId: item.verificationId as number, reason: headlineReason, resolverSkipReason: ESCALATION_CAP_EXCEEDED_SKIP_REASON },
        db,
      );
      plan = { setResolverPath: false, counterKey: "needsHumanCount", outcome: "cap-skipped" };
    } catch (error) {
      if (!isUniqueViolation(error, "review_queue_verification_id_unique")) throw error;
      plan = planFromWinningOutcome(await readReviewQueueOutcome(db, item.verificationId as number));
    }
  } catch (error) {
    // Covers BOTH a genuine insert failure and a throw from
    // readReviewQueueOutcome itself (its own "expected a row, found none"
    // defensive check) — neither may escape uncaught. A pool loop's own
    // catch-all (pool.ts) would keep the process alive either way, but
    // routing through handleResolveFailure here means the item gets a
    // real last_error and a retry/fail decision instead of sitting
    // CLAIMED until its lease times out for no recorded reason.
    return handleResolveFailure(db, item, backoffConfig, error);
  }
  return completeResolveItem(db, item, plan);
}

/**
 * Runs the resolver for one claimed `RESOLVE` item and persists the
 * outcome. Never throws for an ordinary processing failure — see
 * `processExtractClaim`'s own doc comment for why.
 */
export async function processResolveClaim(item: ClaimedBatchQueueItem, deps: Partial<ResolveWorkerDeps> & Pick<ResolveWorkerDeps, "readLabelImage">): Promise<ResolveClaimOutcome> {
  const d: ResolveWorkerDeps = { ...defaultDeps(), ...deps };
  if (item.kind !== "RESOLVE" || item.verificationId === null || item.resolverInput === null || item.claimToken === null) {
    throw new Error(`processResolveClaim called with a non-RESOLVE or malformed claim (item ${item.id})`);
  }

  const parsed = parseResolverInputSnapshot(item.resolverInput);
  if (!parsed.ok) {
    return handleResolveFailure(d.db, item, d.backoffConfig, new Error(`resolver_input rejected: ${parsed.reason}`));
  }
  const snapshot = parsed.snapshot;
  const headlineReason = snapshot.router.headlineReason;
  if (!headlineReason) {
    // Contract violation, not a normal input — the EXTRACT worker's own
    // invariant check (extract-worker.ts) already guarantees a REVIEW
    // snapshot always carries one. Defensive, standing rule 13.
    return handleResolveFailure(d.db, item, d.backoffConfig, new Error("resolver_input.router has labelVerdict REVIEW but no headlineReason"));
  }

  let resolverInput: ResolverInput;
  try {
    const verificationRow = await d.db.query.verifications.findFirst({
      where: (v, { eq }) => eq(v.id, item.verificationId as number),
      with: { application: true, labelImage: true },
    });
    if (!verificationRow || !verificationRow.application || !verificationRow.labelImage) {
      throw new Error(`verification ${item.verificationId} or its application/labelImage not found for batch_queue_item ${item.id}`);
    }
    const applicationRow: ApplicationRow = verificationRow.application;
    const labelImageRow = verificationRow.labelImage;

    const original = await d.readLabelImage(labelImageRow.storagePath);
    const sonnetVariant = await resizeStoredOriginalToSonnetVariant(original, labelImageRow.widthPx, labelImageRow.heightPx);

    resolverInput = {
      verificationId: item.verificationId as number,
      image: { data: sonnetVariant.buffer.toString("base64"), mediaType: "image/jpeg" },
      extraction: snapshot.extraction,
      application: toApplicationRecord(applicationRow),
      router: snapshot.router,
      flaggedFields: snapshot.flaggedFields,
    };
  } catch (error) {
    return handleResolveFailure(d.db, item, d.backoffConfig, error);
  }

  const batchJobRow = await d.db.query.batchJobs.findFirst({ where: (bj, { eq }) => eq(bj.id, item.batchJobId) });
  if (!batchJobRow) {
    // Unreachable under normal operation — batch_queue_items.batch_job_id
    // is a NOT NULL FK to batch_jobs. Defensive, not a real code path.
    throw new Error(`batch job ${item.batchJobId} not found for batch_queue_item ${item.id}`);
  }
  const capThreshold = computeSonnetCallCapThreshold(batchJobRow.totalCount);
  const reserved = await reserveSonnetCall(d.db, item.batchJobId, capThreshold);

  if (!reserved) {
    return completeCapSkip(d.db, item, headlineReason, d.backoffConfig);
  }

  // TRO-566 finding 1/2 — reserve real dollar budget AFTER the
  // escalation-cap reservation above, BEFORE calling resolveEscalatedLabel.
  // See this file's header comment for the ordering tradeoff this accepts.
  // A refused reservation throws; the outer catch below classifies and
  // retries it exactly like any other retryable condition.
  const dollarReservation = await (d.reserveBudget ?? (async () => ALLOW_ALL_RESERVATION))(SONNET_CALL_RESERVE_ESTIMATE_USD);
  if (!dollarReservation.reserved) {
    return handleResolveFailure(d.db, item, d.backoffConfig, new BudgetExhaustedError(dollarReservation));
  }

  let plan: CompletionPlan;
  try {
    try {
      const usageCapture = wrapAnthropicClientForUsageCapture(d.anthropicClient);
      try {
        const result = await (d.resolveEscalatedLabel ?? defaultResolveEscalatedLabel)(resolverInput, { client: usageCapture.client, db: d.db });
        plan = { setResolverPath: true, counterKey: result.outcome === "resolved" ? "resolvedBySonnetCount" : "needsHumanCount", outcome: result.outcome };
      } finally {
        // Settles regardless of success/failure below — `takeLastUsage()`
        // is non-null exactly when `messages.create` genuinely ran, which
        // is true whether resolveEscalatedLabel goes on to return
        // normally, throw a unique-violation this outer catch recovers
        // from, or throw a genuine error this function re-throws. A caller
        // that reused another caller's already-finished result (this
        // file's header comment, TRO-506) never touches the client at
        // all — takeLastUsage() answers null, and the FULL reservation
        // comes back out.
        const sonnetUsage = usageCapture.takeLastUsage();
        await settleReservationBestEffort(d.settleBudget, dollarReservation.reservedUsd, sonnetUsage ? sonnetCallCostUsd(sonnetUsage) : 0);
      }
    } catch (error) {
      if (!isUniqueViolation(error, "review_queue_verification_id_unique")) throw error;
      plan = planFromWinningOutcome(await readReviewQueueOutcome(d.db, item.verificationId as number));
    }
  } catch (error) {
    // Same reasoning as completeCapSkip's own catch: a throw from
    // readReviewQueueOutcome (or any other unexpected error) must not
    // escape uncaught — it goes through the normal retry/fail path too.
    return handleResolveFailure(d.db, item, d.backoffConfig, error);
  }

  return completeResolveItem(d.db, item, plan);
}
